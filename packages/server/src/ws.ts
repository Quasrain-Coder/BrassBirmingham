/**
 * WebSocket 传输层 + HTTP 静态托管（M2 Task 6，server 包收口）。
 *
 * 结构：http.createServer + ws.Server({ noServer })；upgrade 只接受路径 /ws（其余 426）。
 * staticDir 存在时同一 http.Server 托管静态文件（生产单端口：静态 + /ws 共端口；dev 不起
 * staticDir，由 vite proxy 转发 /ws）。
 *
 * 广播安全：room_state 一律走 toRoomState（无 token、config 无 seed 值）；credentials
 * （seat+token）仅 create/join/resume 时单发本人。submit_action 以 token → seat 映射校验
 * 身份（防代打）。resume：开局后查库 findSeatByToken 再对内存 session（进程重启丢对局，
 * 库有记录而内存无 session 回 'session-lost'）；开局前走 RoomManager 内存索引。
 *
 * 心跳：interval（默认 30s）server 发 ws 控制帧 ping；超过 timeout（默认 60s）未收 pong
 * 即 terminate。应用层 'ping' 消息另回 'pong' JSON（协议消息，与控制帧无关）。
 *
 * 断线：座位 connected=false 并广播 room_state；resume 成功 connected=true 再广播。
 * 同座位多连接：resume 先踢掉该座位旧连接（解绑 + terminate），其 close 不再触发断线广播。
 *
 * M3（AI 座位 + LLM 驱动循环）：options.aiAgentFactory 为注入缝——测试注入 fixture
 * agent，main.ts 用 AnthropicClient 构造 LLMAgent；缺省（含 ANTHROPIC_API_KEY 缺失
 * 的降级路径）用 HeuristicAgent。driveAI 在 startGame/submitAction/resume/心跳后触发
 * （幂等）：同一 session 同时只有一个 driveAI（driving 守卫防重入）；**循环体整体
 * try/catch**——任何未预期异常 → error 日志 + HeuristicAgent Top-1 直接 submitAction
 * 末级兜底（再失败才放弃，等下次触发），对局永不卡死。AI 决策广播 ai_thinking
 * （true→false 成对），AI 的 action_applied 带 reason；usage 记内存，终局打日志行。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { PROTOCOL_VERSION } from '@brass/protocol';
import type { ClientMessage, ServerMessage } from '@brass/protocol';
import { enumerateActions } from '@brass/engine';
import type { Action, PlayerIndex } from '@brass/engine';
import { HeuristicAgent, type DecidingAgent, type Difficulty } from '@brass/llm';
import { RoomError, RoomManager, toRoomState, type Room, type Seat } from './rooms.js';
import { GameSession, SessionError, type SessionSeat } from './session.js';
import { findSeatByToken, openDb, type Db } from './db/repo.js';

export interface GameServerOptions {
  port: number;
  dbPath: string;
  /** 静态文件根目录（生产单端口托管 web dist）；缺省不托管。 */
  staticDir?: string;
  /** 心跳 ping 间隔，默认 30_000ms。 */
  heartbeatIntervalMs?: number;
  /** 无 pong 断开阈值，默认 60_000ms。 */
  heartbeatTimeoutMs?: number;
  /**
   * AI agent 注入缝：按座位与难度构造决策 agent。缺省用 HeuristicAgent
   * （ANTHROPIC_API_KEY 缺失时的降级路径同此）。每个 AI 座位开局时各构造一个。
   */
  aiAgentFactory?: (seat: PlayerIndex, difficulty: Difficulty) => DecidingAgent;
}

export interface GameServer {
  /** 实际监听端口（传 port: 0 时为系统分配值）。 */
  readonly port: number;
  close(): Promise<void>;
}

/** 传输层自产错误码（RoomError/SessionError 之外）：code 机器可读，直接透传给 client。 */
class WsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WsError';
    this.code = code;
  }
}

interface Conn {
  ws: WebSocket;
  roomCode: string | null;
  seat: PlayerIndex | null;
  lastPongAt: number;
}

/** 进行中对局：session + 所在房间 + token → seat 映射（submit_action 身份校验）。 */
interface SessionEntry {
  session: GameSession;
  room: Room;
  /** 仅真人座位的 token（AI token 永不进任何索引）。 */
  tokenSeats: Map<string, PlayerIndex>;
  /** AI 座位 → 决策 agent（开局时经 aiAgentFactory 各构造一个）。 */
  agents: Map<PlayerIndex, DecidingAgent>;
  /** driveAI 并发守卫：同一 session 同时只有一个驱动循环。 */
  driving: boolean;
  /** AI 决策 token 用量（M4 用；本任务记内存 + 终局日志行）。 */
  usage: { decisions: number; input: number; output: number };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export async function createGameServer(options: GameServerOptions): Promise<GameServer> {
  const db: Db = openDb(options.dbPath);
  const rooms = new RoomManager();
  const conns = new Set<Conn>();
  const sessionsByGameId = new Map<string, SessionEntry>();
  const sessionByToken = new Map<string, SessionEntry>();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
  const staticRoot = options.staticDir !== undefined ? resolve(options.staticDir) : null;
  /** driveAI 末级兜底用的共享 HeuristicAgent（无状态，可复用）。 */
  const lastResort = new HeuristicAgent();

  const httpServer: Server = createServer((req, res) => {
    void serveStatic(req, res, staticRoot);
  });
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  function send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch {
      // 连接过渡态（terminate 后 close 未处理完）send 可同步抛——单连接投递失败
      // 不应炸掉广播方（尤其 driveAI 的 async 循环，抛出会变 unhandled rejection）。
      // close 事件随后统一清理该连接。
    }
  }

  function sendError(conn: Conn, code: string, message: string): void {
    send(conn, { type: 'error', protocolVersion: PROTOCOL_VERSION, code, message });
  }

  /** 广播 room_state（toRoomState 广播安全视图；yourSeat 按接收连接各自填）。 */
  function broadcastRoomState(room: Room): void {
    const state = toRoomState(room);
    for (const conn of conns) {
      if (conn.roomCode !== room.code) continue;
      send(conn, {
        type: 'room_state',
        protocolVersion: PROTOCOL_VERSION,
        room: state,
        yourSeat: conn.seat,
      });
    }
  }

  function broadcast(room: Room, msg: ServerMessage): void {
    for (const conn of conns) {
      if (conn.roomCode !== room.code) continue;
      send(conn, msg);
    }
  }

  /** 每人视角快照（legalActions 仅当前玩家非空）。 */
  function broadcastSnapshots(entry: SessionEntry): void {
    for (const conn of conns) {
      if (conn.roomCode !== entry.room.code || conn.seat === null) continue;
      const snap = entry.session.snapshotFor(conn.seat);
      send(conn, {
        type: 'snapshot',
        protocolVersion: PROTOCOL_VERSION,
        seq: snap.seq,
        state: snap.state,
        legalActions: snap.legalActions,
      });
    }
  }

  function attach(conn: Conn, room: Room, seat: PlayerIndex): void {
    conn.roomCode = room.code;
    conn.seat = seat;
  }

  /**
   * resume 抢座：解除同座位已有旧连接的绑定并 terminate。先清空 roomCode/seat 再
   * terminate——旧连接的 close 事件随后触发 handleDisconnect 时已无座位绑定，不会再
   * 把座位误标 connected=false 并广播（同座位多连接只保留最新连接）。
   */
  function kickSeatConns(room: Room, seat: PlayerIndex, except: Conn): void {
    for (const other of conns) {
      if (other === except) continue;
      if (other.roomCode !== room.code || other.seat !== seat) continue;
      other.roomCode = null;
      other.seat = null;
      other.ws.terminate();
    }
  }

  function assertDetached(conn: Conn): void {
    if (conn.roomCode !== null) {
      throw new WsError('already-in-room', `连接已在房间 ${conn.roomCode}，先断开再换房`);
    }
  }

  function setSeatConnected(room: Room, seat: PlayerIndex, connected: boolean): void {
    const seatObj = room.seats[seat];
    if (seatObj === null || seatObj === undefined) return;
    seatObj.connected = connected;
  }

  function handleCreateRoom(conn: Conn, msg: { nickname: string; config: unknown }): void {
    assertDetached(conn);
    if (typeof msg.nickname !== 'string' || typeof msg.config !== 'object' || msg.config === null) {
      throw new WsError('bad-message', 'create_room 需要 nickname(string) 与 config(object)');
    }
    const { room, seat, token } = rooms.createRoom(
      msg.config as Parameters<RoomManager['createRoom']>[0],
      msg.nickname,
    );
    attach(conn, room, seat);
    send(conn, { type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat, token });
    broadcastRoomState(room);
  }

  function handleJoinRoom(conn: Conn, msg: { code: string; nickname: string }): void {
    assertDetached(conn);
    if (typeof msg.code !== 'string' || typeof msg.nickname !== 'string') {
      throw new WsError('bad-message', 'join_room 需要 code(string) 与 nickname(string)');
    }
    const { room, seat, token } = rooms.joinRoom(msg.code, msg.nickname);
    attach(conn, room, seat);
    send(conn, { type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat, token });
    broadcastRoomState(room);
  }

  function handleStartGame(msg: { token: string }): void {
    if (typeof msg.token !== 'string') throw new WsError('bad-message', 'start_game 需要 token');
    // RoomError：not-in-room / already-started / room-not-full
    const room = rooms.startGame(msg.token);
    const seats: SessionSeat[] = [];
    const agents = new Map<PlayerIndex, DecidingAgent>();
    const difficulty: Difficulty = room.config.aiSeats?.difficulty ?? 'normal';
    for (const s of room.seats) {
      if (s === null) throw new Error('unreachable: startGame 校验后仍有空座位');
      seats.push({ seat: s.seat, nickname: s.nickname, token: s.token });
      if (s.isAI) agents.set(s.seat, makeAgent(s.seat, difficulty));
    }
    if (room.seed === null) throw new Error('unreachable: startGame 后 seed 未落地');
    // seats（含 token）随开局落库；roomCode 传真实房间码
    const session = new GameSession(db, undefined, room.config.playerCount, room.seed, seats, room.code);
    const entry: SessionEntry = {
      session,
      room,
      // AI token 不进任何索引（伪造 token 永不可达：submit/resume 均 invalid-token）
      tokenSeats: new Map(
        room.seats
          .filter((s): s is Seat => s !== null && !s.isAI)
          .map((s) => [s.token, s.seat]),
      ),
      agents,
      driving: false,
      usage: { decisions: 0, input: 0, output: 0 },
    };
    sessionsByGameId.set(session.gameId, entry);
    for (const token of entry.tokenSeats.keys()) sessionByToken.set(token, entry);
    broadcastRoomState(room);
    broadcastSnapshots(entry);
    void driveAI(entry);
  }

  /** AI agent 构造：注入缝优先，缺省 HeuristicAgent（key 缺失降级路径同此）。 */
  function makeAgent(seat: PlayerIndex, difficulty: Difficulty): DecidingAgent {
    if (options.aiAgentFactory !== undefined) return options.aiAgentFactory(seat, difficulty);
    return new HeuristicAgent();
  }

  /** AI 行动落库 + 广播（action_applied 带 reason/degraded；终局则补 game_over）。 */
  function applyAIAction(entry: SessionEntry, seat: PlayerIndex, action: Action, reason: string, degraded: boolean): void {
    const { seq } = entry.session.submitAction(seat, action);
    broadcast(entry.room, {
      type: 'action_applied',
      protocolVersion: PROTOCOL_VERSION,
      seq,
      player: seat,
      action,
      events: entry.session.state.lastEvents,
      reason,
      ...(degraded ? { degraded: true } : {}),
    });
    broadcastSnapshots(entry);
    if (entry.session.finished) {
      broadcastGameOver(entry);
    }
  }

  function broadcastGameOver(entry: SessionEntry): void {
    const st = entry.session.state;
    broadcast(entry.room, {
      type: 'game_over',
      protocolVersion: PROTOCOL_VERSION,
      winner: st.winner ?? [],
      finalScores: st.players.map((p) => p.vp),
    });
    if (entry.usage.decisions > 0) {
      console.log(
        `[ai] game=${entry.session.gameId} 终局 usage：` +
          `decisions=${entry.usage.decisions} input=${entry.usage.input} output=${entry.usage.output}`,
      );
    }
  }

  /**
   * AI 驱动循环：startGame/submitAction/resume/心跳后触发（幂等）。
   *
   * - 守卫：entry.driving 保证同一 session 同时只有一个驱动循环（检查+置位之间
   *   无 await，单线程下原子）；重入直接返回。
   * - 循环体整体 try/catch：任何未预期异常（summarize/prescreen bug、submitAction
   *   非预期抛出、API 层漏网异常）→ error 日志 + HeuristicAgent Top-1 末级兜底
   *   直接 submitAction；兜底再失败才放弃本次驱动（ai_thinking(false) 照发，
   *   等 resume/心跳再次触发），对局永不卡死。
   * - ai_thinking(true) 按座位广播，循环结束（含异常路径）对所有广播过 true 的
   *   座位补 false（成对）。
   */
  async function driveAI(entry: SessionEntry): Promise<void> {
    if (entry.driving) return;
    entry.driving = true;
    const thinkingSeats = new Set<PlayerIndex>();
    try {
      while (!entry.session.finished && entry.agents.has(entry.session.currentSeat)) {
        const seat = entry.session.currentSeat;
        const agent = entry.agents.get(seat)!;
        broadcast(entry.room, {
          type: 'ai_thinking',
          protocolVersion: PROTOCOL_VERSION,
          seat,
          thinking: true,
        });
        thinkingSeats.add(seat);
        try {
          const state = entry.session.state;
          const legal = enumerateActions(state, seat);
          const decision = await agent.decide(state, seat, legal);
          applyAIAction(entry, seat, decision.action, decision.reason, decision.degraded);
          // usage 只在行动成功落库后计数（submit 抛错不虚增）
          entry.usage.decisions += 1;
          entry.usage.input += decision.usage.input;
          entry.usage.output += decision.usage.output;
        } catch (err) {
          console.error(
            `[ai] driveAI 未预期异常（game=${entry.session.gameId} seat=${seat}），走 Heuristic 末级兜底`,
            err,
          );
          try {
            // submitAction 校验序抛错时对局状态未变（session.submitAction 先校验后
            // 替换内存态），currentSeat 应仍等于 seat；不等则说明状态已被外力推进，
            // 交回循环条件重估。
            if (entry.session.finished || entry.session.currentSeat !== seat) continue;
            const state = entry.session.state;
            const legal = enumerateActions(state, seat);
            const d = await lastResort.decide(state, seat, legal);
            applyAIAction(entry, seat, d.action, `末级兜底（agent 异常）：${d.reason}`, true);
          } catch (fallbackErr) {
            console.error(
              `[ai] 末级兜底失败（game=${entry.session.gameId} seat=${seat}），放弃本次驱动`,
              fallbackErr,
            );
            break;
          }
        }
      }
    } catch (err) {
      // 循环体已整体 try/catch，理论不可达；兜底防 unhandled rejection
      console.error(`[ai] driveAI 外层异常（game=${entry.session.gameId}）`, err);
    } finally {
      entry.driving = false;
      for (const seat of thinkingSeats) {
        broadcast(entry.room, {
          type: 'ai_thinking',
          protocolVersion: PROTOCOL_VERSION,
          seat,
          thinking: false,
        });
      }
    }
  }

  function handleSubmitAction(msg: { token: string; action: unknown }): void {
    if (typeof msg.token !== 'string') throw new WsError('bad-message', 'submit_action 需要 token');
    const entry = sessionByToken.get(msg.token);
    if (entry === undefined) {
      if (rooms.findByToken(msg.token) !== null) {
        throw new WsError('not-started', '对局尚未开始，不能提交行动');
      }
      throw new WsError('invalid-token', 'token 不属于任何进行中对局');
    }
    // token → seat 映射：身份由 token 唯一决定，client 无法指定座位代打
    const seat = entry.tokenSeats.get(msg.token);
    if (seat === undefined) throw new WsError('invalid-token', 'token 无效');
    // SessionError：game-finished / not-your-turn / engine 合法性 code 透传
    const { seq } = entry.session.submitAction(
      seat,
      msg.action as Parameters<GameSession['submitAction']>[1],
    );
    broadcast(entry.room, {
      type: 'action_applied',
      protocolVersion: PROTOCOL_VERSION,
      seq,
      player: seat,
      action: msg.action as Parameters<GameSession['submitAction']>[1],
      events: entry.session.state.lastEvents,
    });
    broadcastSnapshots(entry);
    if (entry.session.finished) {
      broadcastGameOver(entry);
    }
    void driveAI(entry);
  }

  /**
   * 主动退出对局/房间（leave 消息）：清 token 索引 → 处理座位 → 广播 →
   * 解绑本连接并 terminate（close 时因已解绑不再重复广播）。
   * - 对局进行中：座位标记断线（原对局继续，AI 座位由 driveAI 自动推进；
   *   真人缺位暂不托管，属已知范围）。
   * - 开局前：座位直接清空（置 null）——否则剩余玩家开局的"幽灵座位"是
   *   非 AI 真人位，token 已失效、driveAI 不推进，轮到即对局永久卡死。
   */
  function handleLeave(conn: Conn, msg: { token: string }): void {
    if (typeof msg.token !== 'string') throw new WsError('bad-message', 'leave 需要 token');
    if (conn.roomCode === null || conn.seat === null) {
      throw new WsError('not-in-room', '当前不在任何房间');
    }
    const room = rooms.getRoom(conn.roomCode);
    if (room === null) throw new WsError('room-not-found', '房间不存在');
    // 清 token 索引：被踢 token 不再能 resume/submit
    const entry = sessionByToken.get(msg.token);
    if (entry !== undefined) {
      entry.tokenSeats.delete(msg.token);
      sessionByToken.delete(msg.token);
    } else {
      rooms.dropToken(msg.token);
      // 开局前：清空座位（避免幽灵座位卡死后续开局）
      room.seats[conn.seat] = null;
    }
    if (entry !== undefined) {
      setSeatConnected(room, conn.seat, false);
    }
    broadcastRoomState(room);
    // 解绑后 terminate：close 事件里的 handleDisconnect 因 seat 已 null 不再广播
    conn.roomCode = null;
    conn.seat = null;
    conn.ws.terminate();
  }

  function handleResume(conn: Conn, msg: { token: string }): void {
    assertDetached(conn);
    if (typeof msg.token !== 'string') throw new WsError('bad-message', 'resume 需要 token');
    // 开局后：seats 表查 token → gameId，再对内存 session
    const persisted = findSeatByToken(db, msg.token);
    if (persisted !== null) {
      const entry = sessionsByGameId.get(persisted.gameId);
      if (entry === undefined) {
        throw new WsError('session-lost', '对局已随服务器重启丢失（M2 不恢复进行中对局）');
      }
      const seat = entry.tokenSeats.get(msg.token);
      if (seat === undefined) throw new WsError('invalid-token', 'token 与对局座位不一致');
      kickSeatConns(entry.room, seat, conn);
      attach(conn, entry.room, seat);
      setSeatConnected(entry.room, seat, true);
      send(conn, { type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat, token: msg.token });
      const snap = entry.session.snapshotFor(seat);
      send(conn, {
        type: 'snapshot',
        protocolVersion: PROTOCOL_VERSION,
        seq: snap.seq,
        state: snap.state,
        legalActions: snap.legalActions,
      });
      broadcastRoomState(entry.room);
      // resume 重触发 driveAI（幂等，守卫防重入）——对局若停在 AI 回合则被唤醒
      void driveAI(entry);
      return;
    }
    // 开局前：RoomManager 内存索引
    const found = rooms.findByToken(msg.token);
    if (found === null) throw new WsError('invalid-token', 'token 无效');
    kickSeatConns(found.room, found.seat.seat, conn);
    attach(conn, found.room, found.seat.seat);
    found.seat.connected = true;
    send(conn, {
      type: 'credentials',
      protocolVersion: PROTOCOL_VERSION,
      seat: found.seat.seat,
      token: msg.token,
    });
    broadcastRoomState(found.room);
  }

  function routeMessage(conn: Conn, msg: ClientMessage): void {
    switch (msg.type) {
      case 'create_room':
        handleCreateRoom(conn, msg);
        break;
      case 'join_room':
        handleJoinRoom(conn, msg);
        break;
      case 'start_game':
        handleStartGame(msg);
        break;
      case 'submit_action':
        handleSubmitAction(msg);
        break;
      case 'resume':
        handleResume(conn, msg);
        break;
      case 'leave':
        handleLeave(conn, msg);
        break;
      case 'ping':
        send(conn, { type: 'pong', protocolVersion: PROTOCOL_VERSION });
        break;
      default:
        sendError(conn, 'unknown-message', `未知消息类型: ${String((msg as { type: unknown }).type)}`);
    }
  }

  function handleMessage(conn: Conn, data: RawData): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendError(conn, 'bad-message', '消息不是合法 JSON');
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as { type?: unknown }).type !== 'string') {
      sendError(conn, 'bad-message', '消息缺 type 字段');
      return;
    }
    if ((msg as { protocolVersion?: unknown }).protocolVersion !== PROTOCOL_VERSION) {
      sendError(
        conn,
        'protocol-mismatch',
        `协议版本不匹配：期望 ${PROTOCOL_VERSION}，收到 ${String((msg as { protocolVersion?: unknown }).protocolVersion)}`,
      );
      return;
    }
    try {
      routeMessage(conn, msg as ClientMessage);
    } catch (e) {
      if (e instanceof RoomError || e instanceof SessionError || e instanceof WsError) {
        sendError(conn, e.code, e.message);
      } else {
        console.error('[ws] 未预期错误', e);
        sendError(conn, 'internal-error', '服务器内部错误');
      }
    }
  }

  function handleDisconnect(conn: Conn): void {
    if (conn.roomCode === null || conn.seat === null) return;
    const room = rooms.getRoom(conn.roomCode);
    if (room === null) return;
    const seatObj = room.seats[conn.seat];
    if (seatObj === null || seatObj === undefined || !seatObj.connected) return;
    seatObj.connected = false;
    broadcastRoomState(room);
  }

  wss.on('connection', (ws: WebSocket) => {
    const conn: Conn = { ws, roomCode: null, seat: null, lastPongAt: Date.now() };
    conns.add(conn);
    ws.on('pong', () => {
      conn.lastPongAt = Date.now();
    });
    ws.on('message', (data: RawData) => {
      handleMessage(conn, data);
    });
    ws.on('close', () => {
      conns.delete(conn);
      handleDisconnect(conn);
    });
    ws.on('error', () => {
      // close 事件随后统一清理
    });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const conn of conns) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      if (now - conn.lastPongAt > heartbeatTimeoutMs) {
        conn.ws.terminate();
        continue;
      }
      conn.ws.ping();
    }
    // 心跳重触发 driveAI（幂等，守卫防重入）：兜底放弃/异常中断的驱动借此复活
    for (const entry of sessionsByGameId.values()) void driveAI(entry);
  }, heartbeatIntervalMs);
  heartbeat.unref();

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(options.port, () => {
      httpServer.removeListener('error', rejectListen);
      resolveListen();
    });
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const conn of conns) conn.ws.terminate();
    await new Promise<void>((res) => {
      wss.close(() => res());
    });
    await new Promise<void>((resolveClose, rejectClose) => {
      httpServer.close((err) => (err !== undefined ? rejectClose(err) : resolveClose()));
    });
    db.$client.close();
  }

  return { port, close };
}

/** 静态文件托管：GET -only，/ 补 index.html，resolve 出根目录一律 404。 */
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  staticRoot: string | null,
): Promise<void> {
  if (staticRoot === null || req.method !== 'GET') {
    res.writeHead(404).end('not found');
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = resolve(staticRoot, `.${pathname}`);
  if (filePath !== staticRoot && !filePath.startsWith(staticRoot + sep)) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}
