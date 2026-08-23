/**
 * WebSocket 传输层 + HTTP 静态托管（M2 Task 6，server 包收口）。
 *
 * 结构：http.createServer + ws.Server({ noServer })；upgrade 只接受路径 /ws（其余 426）。
 * staticDir 存在时同一 http.Server 托管静态文件（生产单端口：静态 + /ws 共端口；dev 不起
 * staticDir，由 vite proxy 转发 /ws）。
 *
 * 广播安全：room_state 一律走 toRoomState（无 token、config 无 seed 值）；credentials
 * （seat+token）仅 create/join/resume 时单发本人。submit_action 以 token → seat 映射校验
 * 身份（防代打）。resume：开局后查库 findSeatByToken 再对内存 session；进程重启后内存
 * session 丢失时按库（games + actions 表）重放恢复（GameSession.restore），仅已终局或
 * 重放失败才回 'session-lost'；开局前走 RoomManager 内存索引。
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
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { PROTOCOL_VERSION } from '@brass/protocol';
import type { ClientMessage, DraftPreview, GameRecord, ServerMessage } from '@brass/protocol';
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import type { Action, PlayerIndex } from '@brass/engine';
import { HeuristicAgent, type DecidingAgent, type Difficulty } from '@brass/llm';
import { RoomError, RoomManager, toRoomState, type Room, type Seat } from './rooms.js';
import { GameSession, SessionError, type SessionSeat } from './session.js';
import { findGameById, findSeatByToken, listActions, listSeats, openDb, type Db } from './db/repo.js';

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
  /**
   * AI 行动节奏（ms）：每步 AI 行动之间的间隔，让真人玩家看得清 AI 过程
   * （启发式瞬算时 AI 连动会在一帧内打完）。缺省 0（测试不减速）;生产 main.ts 注入。
   */
  aiPaceMs?: number;
  /**
   * 轮末停顿（ms）：收官玩家 end_turn 后、下一轮开始前的等待时长——期间全场
   * 播"第 x 轮结束",末位玩家版图仍展示其本轮行动。缺省 0(测试不停顿);
   * 生产 main.ts 注入。
   */
  roundBreakMs?: number;
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
  /**
   * 扣住的回合：真人行动数打满后等待其显式"结束回合"(end_turn 放行 /
   * reset_turn 撤销重来);期间 driveAI 不推进、一切 submit 被拒。
   */
  turnHold: PlayerIndex | null;
  /** 被扣住的回合是否同时结束了一轮(收官回合):end_turn 时进入轮末停顿。 */
  holdEndedRound: boolean;
  /** 轮末停顿计时器(收官 end_turn 后播"第 x 轮结束"再放行);reset/放行时清除。 */
  roundBreakTimer: NodeJS.Timeout | null;
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
  /** AI 行动节奏:与客户端聚光灯时长对齐,每步 AI 行动播足 5 秒(生产注入,测试为 0)。 */
  const aiPaceMs = options.aiPaceMs ?? 0;
  /** 轮末停顿:收官玩家 end_turn 后播"第 x 轮结束"的时长(生产注入 5s,测试为 0)。 */
  const roundBreakMs = options.roundBreakMs ?? 0;
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

  /** 每人视角快照（legalActions 仅当前玩家非空；附带 turnHold 扣回合状态）。 */
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
        turnHold: entry.turnHold,
        roundBreak: entry.roundBreakTimer !== null,
        playedCards: snap.playedCards,
        eraActions: snap.eraActions,
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
    let joined: { room: Room; seat: PlayerIndex; token: string };
    try {
      joined = rooms.joinRoom(msg.code, msg.nickname);
    } catch (e) {
      // 已开局但仍有开放真人座位(导入残局) → 补位加入
      if (e instanceof RoomError && e.code === 'already-started') {
        joined = rooms.joinStartedRoom(msg.code, msg.nickname);
      } else {
        throw e;
      }
    }
    const { room, seat, token } = joined;
    attach(conn, room, seat);
    send(conn, { type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat, token });
    if (room.started) {
      // 补位进已开局对局:补发快照(座位 token 在 import 时已入索引与库)
      const entry = [...sessionsByGameId.values()].find((x) => x.room.code === room.code);
      if (entry !== undefined) {
        const snap = entry.session.snapshotFor(seat);
        send(conn, {
          type: 'snapshot',
          protocolVersion: PROTOCOL_VERSION,
          seq: snap.seq,
          state: snap.state,
          legalActions: snap.legalActions,
          turnHold: entry.turnHold,
          playedCards: snap.playedCards,
          eraActions: snap.eraActions,
        });
      }
    }
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
      seats.push({ seat: s.seat, nickname: s.nickname, token: s.token, isAI: s.isAI });
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
      turnHold: null,
      holdEndedRound: false,
      roundBreakTimer: null,
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

  /**
   * 服务器重启后的对局恢复：库中 status='playing' 的对局重放重建 session，
   * 并按 seats 表重建 Room（adopt 回 RoomManager）与 tokenSeats/agents 索引。
   * 返回 undefined = 不可恢复（对局不存在/已终局/重放失败）。
   * turnHold 不恢复（重启前被扣住的回合视为已放行，对局继续推进，不会卡死）。
   */
  function restoreSessionEntry(gameId: string): SessionEntry | undefined {
    const session = GameSession.restore(db, gameId);
    if (session === null) return undefined;
    const game = findGameById(db, gameId);
    if (game === null) return undefined;
    const seatRows = listSeats(db, gameId);
    const difficulty: Difficulty = game.config.aiSeats?.difficulty ?? 'normal';
    const roomSeats: (Seat | null)[] = Array.from({ length: game.playerCount }, () => null);
    const agents = new Map<PlayerIndex, DecidingAgent>();
    const tokenSeats = new Map<string, PlayerIndex>();
    for (const s of seatRows) {
      roomSeats[s.seat] = {
        seat: s.seat as PlayerIndex,
        nickname: s.nickname,
        token: s.token,
        connected: s.isAI, // AI 恒在线；真人等 resume 置 true
        isAI: s.isAI,
      };
      if (s.isAI) agents.set(s.seat as PlayerIndex, makeAgent(s.seat as PlayerIndex, difficulty));
      else tokenSeats.set(s.token, s.seat as PlayerIndex);
    }
    const room: Room = {
      code: game.roomCode,
      config: game.config,
      seats: roomSeats,
      started: true,
      seed: game.seed,
      customSeed: game.config.seed !== undefined,
    };
    rooms.adopt(room);
    const entry: SessionEntry = {
      session,
      room,
      tokenSeats,
      agents,
      driving: false,
      turnHold: null,
      holdEndedRound: false,
      roundBreakTimer: null,
      usage: { decisions: 0, input: 0, output: 0 },
    };
    sessionsByGameId.set(gameId, entry);
    for (const token of tokenSeats.keys()) sessionByToken.set(token, entry);
    console.log(`[session] 对局 ${gameId} 已经库重放恢复（seq=${session.currentSeq}）`);
    return entry;
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
    if (entry.turnHold !== null) return; // 真人回合被扣住:等 end_turn/reset_turn
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
        // 逐座位结算 thinking(false)(连动时不再整段只收一次);
        // 节奏延迟:启发式瞬算时给真人留看清每步 AI 行动的时间
        broadcast(entry.room, {
          type: 'ai_thinking',
          protocolVersion: PROTOCOL_VERSION,
          seat,
          thinking: false,
        });
        thinkingSeats.delete(seat);
        if (aiPaceMs > 0 && !entry.session.finished && entry.agents.has(entry.session.currentSeat)) {
          await new Promise((r) => setTimeout(r, aiPaceMs));
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
    // 扣回合窗口内:一切行动提交都被拒(等 held 玩家 end_turn/reset_turn)
    if (entry.turnHold !== null) {
      throw new WsError('awaiting-turn-confirm', '等待回合确认：先结束或重置被扣住的回合');
    }
    // token → seat 映射：身份由 token 唯一决定，client 无法指定座位代打
    const seat = entry.tokenSeats.get(msg.token);
    if (seat === undefined) throw new WsError('invalid-token', 'token 无效');
    // SessionError：game-finished / not-your-turn / engine 合法性 code 透传。
    // deferRoundEnd:该行动若结束本轮,轮末结算(顺位/收入/时代清算)全部挂起——
    // 扣住回合,等玩家显式 end_turn 才结算并广播;reset_turn 可整回合撤回
    const { seq, roundEndPending } = entry.session.submitAction(
      seat,
      msg.action as Parameters<GameSession['submitAction']>[1],
      { deferRoundEnd: true },
    );
    // 真人行动后回合推进了 → 扣住,等其显式结束/重置(终局不扣,直接 game_over)。
    // 轮末结算挂起时必须扣住,否则 pending 无人能消费
    if (!entry.session.finished && (roundEndPending || entry.session.currentSeat !== seat)) {
      entry.turnHold = seat;
      // 收官回合(轮末结算挂起)标记:end_turn 结算后进入轮末停顿,播"第 x 轮结束"
      entry.holdEndedRound = roundEndPending;
    }
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

  /** token → {entry, seat} 并校验该座位正是被扣住的玩家。 */
  function heldEntry(msg: { token: string }): { entry: SessionEntry; seat: PlayerIndex } {
    if (typeof msg.token !== 'string') throw new WsError('bad-message', '需要 token');
    const entry = sessionByToken.get(msg.token);
    if (entry === undefined) throw new WsError('invalid-token', 'token 不属于任何进行中对局');
    const seat = entry.tokenSeats.get(msg.token);
    if (seat === undefined || entry.turnHold !== seat) {
      throw new WsError('no-turn-hold', '当前没有需要你确认的回合');
    }
    return { entry, seat };
  }

  /** 结束回合：先消费被 defer 的轮末结算(顺位/收入/时代清算此刻才广播)。
   *  收官回合(非时代切换)且配置了轮末停顿:结算后保持扣住 roundBreakMs,全场播
   *  "第 x 轮结束"(此间末位玩家版图仍显示其本轮行动),到点才放行。 */
  function handleEndTurn(msg: { token: string }): void {
    const { entry } = heldEntry(msg);
    const eraBefore = entry.session.state.era;
    entry.session.settleTurnEnd();
    const eraChanged = entry.session.state.era !== eraBefore;
    if (entry.session.finished) {
      // 清算进终局(rail 末):此时才广播 game_over
      entry.turnHold = null;
      entry.holdEndedRound = false;
      broadcastSnapshots(entry);
      broadcastGameOver(entry);
      return;
    }
    if (entry.holdEndedRound && !eraChanged && roundBreakMs > 0) {
      entry.holdEndedRound = false;
      entry.roundBreakTimer = setTimeout(() => {
        entry.roundBreakTimer = null;
        entry.turnHold = null;
        broadcastSnapshots(entry);
        void driveAI(entry);
      }, roundBreakMs);
      // 停顿期间快照照旧广播(turnHold 保持,各端播轮末横幅、版图停在刚结束轮)
      broadcastSnapshots(entry);
      return;
    }
    entry.holdEndedRound = false;
    entry.turnHold = null;
    broadcastSnapshots(entry);
    void driveAI(entry);
  }

  /** 重置回合：撤销本回合全部行动(恢复回合备份 + 删本回合落库行动),回到回合初。
   *  两种可用时机:① 回合打满被扣住(turnHold=本人);② 自己回合进行中
   *  (actionsThisTurn>0,随时可反悔);其他情况报错。 */
  function handleResetTurn(msg: { token: string }): void {
    if (typeof msg.token !== 'string') throw new WsError('bad-message', '需要 token');
    const entry = sessionByToken.get(msg.token);
    if (entry === undefined) throw new WsError('invalid-token', 'token 不属于任何进行中对局');
    const seat = entry.tokenSeats.get(msg.token);
    if (seat === undefined) throw new WsError('invalid-token', 'token 无效');
    if (entry.turnHold !== null && entry.turnHold !== seat) {
      throw new WsError('awaiting-turn-confirm', '等待回合确认：先结束或重置被扣住的回合');
    }
    const midTurn =
      entry.turnHold === seat ||
      (seat === entry.session.currentSeat && entry.session.state.actionsThisTurn > 0);
    if (!midTurn) {
      throw new WsError('no-turn-hold', '当前没有可重置的回合');
    }
    if (!entry.session.resetTurn()) {
      throw new WsError('no-turn-backup', '回合备份不存在,无法重置');
    }
    // 轮末停顿中重置:取消停顿计时,回合回滚后按正常流程走
    if (entry.roundBreakTimer !== null) {
      clearTimeout(entry.roundBreakTimer);
      entry.roundBreakTimer = null;
    }
    entry.holdEndedRound = false;
    entry.turnHold = null;
    broadcastSnapshots(entry);
    // 全场播报"X 已重置本回合"（他人的暂存预览/播报由 client 据此清除）
    broadcast(entry.room, { type: 'turn_reset', protocolVersion: PROTOCOL_VERSION, seat });
  }

  /**
   * 暂存预览同步（多玩家）：当前行动方点选/改动暂存时上行，服务器校验身份后
   * 广播 player_draft 给同房**其他**连接（发送方本地已自渲染）。draft=null=清除。
   * 纯转发不落库——暂存是瞬态信息,断线/恢复不补发。
   */
  function handleDraftUpdate(conn: Conn, msg: { token: string; draft: DraftPreview | null }): void {
    if (typeof msg.token !== 'string') throw new WsError('bad-message', 'draft_update 需要 token');
    const entry = sessionByToken.get(msg.token);
    if (entry === undefined) throw new WsError('invalid-token', 'token 不属于任何进行中对局');
    const seat = entry.tokenSeats.get(msg.token);
    if (seat === undefined) throw new WsError('invalid-token', 'token 无效');
    for (const other of conns) {
      if (other === conn || other.roomCode !== entry.room.code) continue;
      send(other, {
        type: 'player_draft',
        protocolVersion: PROTOCOL_VERSION,
        seat,
        draft: msg.draft ?? null,
      });
    }
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
      // 扣住的玩家主动离开:自动放行该回合(保留其行动),对局不被永久卡住
      if (entry.turnHold === conn.seat) {
        entry.turnHold = null;
        broadcastSnapshots(entry);
        void driveAI(entry);
      }
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
      // 内存无 session（服务器重启）→ 按库重放恢复；已终局/重放失败才 session-lost
      const entry = sessionsByGameId.get(persisted.gameId) ?? restoreSessionEntry(persisted.gameId);
      if (entry === undefined) {
        throw new WsError('session-lost', '对局已结束或无法恢复');
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
        turnHold: entry.turnHold,
        roundBreak: entry.roundBreakTimer !== null,
        playedCards: snap.playedCards,
        eraActions: snap.eraActions,
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
      case 'end_turn':
        handleEndTurn(msg);
        break;
      case 'reset_turn':
        handleResetTurn(msg);
        break;
      case 'draft_update':
        handleDraftUpdate(conn, msg);
        break;
      case 'resume':
        handleResume(conn, msg);
        break;
      case 'leave':
        handleLeave(conn, msg);
        break;
      case 'export_game':
        handleExportGame(conn, msg);
        break;
      case 'import_game':
        handleImportGame(conn, msg);
        break;
      case 'ping':
        send(conn, { type: 'pong', protocolVersion: PROTOCOL_VERSION });
        break;
      default:
        sendError(conn, 'unknown-message', `未知消息类型: ${String((msg as { type: unknown }).type)}`);
    }
  }

  /** 导出对局记录：从库读出整局行动日志（开局到当前进度），客户端下载为 JSON。 */
  function handleExportGame(conn: Conn, msg: { token: string }): void {
    if (typeof msg.token !== 'string') throw new WsError('bad-message', 'export_game 需要 token');
    const entry = sessionByToken.get(msg.token);
    if (entry === undefined) throw new WsError('invalid-token', 'token 不属于任何进行中对局');
    const game = findGameById(db, entry.session.gameId);
    if (game === null) throw new WsError('session-lost', '对局不存在');
    const record: GameRecord = {
      version: 1,
      playerCount: game.playerCount as 2 | 3 | 4,
      seed: game.seed,
      seats: listSeats(db, game.id).map((s) => ({
        seat: s.seat as PlayerIndex,
        nickname: s.nickname,
        isAI: s.isAI,
      })),
      actions: listActions(db, game.id).map((r) => ({
        seq: r.seq,
        player: r.player as PlayerIndex,
        action: r.action,
      })),
    };
    send(conn, { type: 'export_data', protocolVersion: PROTOCOL_VERSION, record });
  }

  /**
   * 导入对局记录并从残局开新局：先内存校验整个行动前缀可重放（顺序/合法性），
   * 再落库建新局逐条提交（与 restore 同路径 inline 结算）。导入者占 msg.seat
   * 指定座位（在线）；其余真人座位保持开放（connected=false,join_room 补位）；
   * 记录里的 AI 座位照常由 driveAI 接管。
   */
  function handleImportGame(conn: Conn, msg: { record: GameRecord; seat: PlayerIndex; nickname: string }): void {
    // 已在房间:先从当前房间解绑(旧对局可用原 token resume),再开新局
    if (conn.roomCode !== null && conn.seat !== null) {
      const oldRoom = rooms.getRoom(conn.roomCode);
      if (oldRoom !== null) {
        setSeatConnected(oldRoom, conn.seat, false);
        broadcastRoomState(oldRoom);
      }
      conn.roomCode = null;
      conn.seat = null;
    }
    const rec = msg.record;
    if (
      rec === null ||
      typeof rec !== 'object' ||
      rec.version !== 1 ||
      (rec.playerCount !== 2 && rec.playerCount !== 3 && rec.playerCount !== 4) ||
      !Array.isArray(rec.seats) ||
      !Array.isArray(rec.actions) ||
      typeof rec.seed !== 'number'
    ) {
      throw new WsError('bad-message', 'import_game 记录格式非法');
    }
    if (typeof msg.seat !== 'number' || msg.seat < 0 || msg.seat >= rec.playerCount) {
      throw new WsError('invalid-seat', `座位 ${String(msg.seat)} 越界`);
    }
    const seatIdx = msg.seat as PlayerIndex;
    // ① 内存校验:整个前缀按顺序可重放
    try {
      let s = newGame(rec.playerCount, rec.seed);
      for (const { player, action } of rec.actions) {
        if (player !== s.turnOrder[s.currentPlayerIdx]) {
          throw new Error(`行动者错位(player=${player},当前=${s.turnOrder[s.currentPlayerIdx]})`);
        }
        s = applyAction(s, action);
      }
    } catch (e) {
      throw new WsError('import-invalid', `行动日志无法重放: ${(e as Error).message}`);
    }
    if (typeof msg.nickname !== 'string' || msg.nickname.trim() === '') {
      throw new WsError('bad-message', 'import_game 需要 nickname(string)');
    }
    // ② 落库建新局并逐条提交(隐式校验同上,理论不再失败)
    const sessionSeats: SessionSeat[] = Array.from({ length: rec.playerCount }, (_, i) => {
      const r = rec.seats.find((x) => x.seat === i);
      return {
        seat: i as PlayerIndex,
        nickname: i === seatIdx ? msg.nickname.trim() : (r?.nickname ?? `玩家${i + 1}`),
        token: randomBytes(18).toString('base64url'),
        isAI: i === seatIdx ? false : (r?.isAI ?? false),
      };
    });
    const code = rooms.newCode();
    const session = new GameSession(db, undefined, rec.playerCount, rec.seed, sessionSeats, code);
    for (const { player, action } of rec.actions) {
      session.submitAction(player as PlayerIndex, action);
    }
    // ③ Room + SessionEntry:导入者在线,其余真人座位开放,AI 座位接管
    const agents = new Map<PlayerIndex, DecidingAgent>();
    const tokenSeats = new Map<string, PlayerIndex>();
    const roomSeats: Seat[] = sessionSeats.map((s) => {
      const online = s.seat === seatIdx || s.isAI === true;
      if (s.isAI === true) agents.set(s.seat, makeAgent(s.seat, 'normal'));
      else tokenSeats.set(s.token, s.seat);
      return { seat: s.seat, nickname: s.nickname, token: s.token, connected: online, isAI: s.isAI === true };
    });
    const room: Room = {
      code,
      config: { playerCount: rec.playerCount, seed: rec.seed },
      seats: roomSeats,
      started: true,
      seed: rec.seed,
      customSeed: true,
    };
    rooms.adopt(room);
    const entry: SessionEntry = {
      session,
      room,
      tokenSeats,
      agents,
      driving: false,
      turnHold: null,
      holdEndedRound: false,
      roundBreakTimer: null,
      usage: { decisions: 0, input: 0, output: 0 },
    };
    sessionsByGameId.set(session.gameId, entry);
    for (const token of tokenSeats.keys()) sessionByToken.set(token, entry);
    attach(conn, room, seatIdx);
    send(conn, {
      type: 'credentials',
      protocolVersion: PROTOCOL_VERSION,
      seat: seatIdx,
      token: sessionSeats[seatIdx]!.token,
    });
    const snap = entry.session.snapshotFor(seatIdx);
    send(conn, {
      type: 'snapshot',
      protocolVersion: PROTOCOL_VERSION,
      seq: snap.seq,
      state: snap.state,
      legalActions: snap.legalActions,
      turnHold: entry.turnHold,
      playedCards: snap.playedCards,
      eraActions: snap.eraActions,
    });
    broadcastRoomState(room);
    void driveAI(entry);
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
    // 缓存策略:
    // - 带内容指纹的构建产物(index-<hash>.js/css):immutable 长缓存;
    // - index.html:no-cache 每次校验,避免旧 HTML 引用新指纹资源(或反之)白屏;
    // - 图片等游戏素材:1 天缓存 + ETag——局域网/IP 访问不再每次全量重下,
    //   过期后也只走 304 轻量校验;素材更新(fetch-assets)后 ETag 随 mtime 变化。
    const isFingerprint = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(pathname);
    const isHtml = pathname.endsWith('.html');
    const headers: Record<string, string> = {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': isFingerprint
        ? 'public, max-age=31536000, immutable'
        : isHtml
          ? 'no-cache'
          : 'public, max-age=86400',
    };
    if (!isFingerprint && !isHtml) {
      const st = await stat(filePath);
      const etag = `W/"${Math.round(st.mtimeMs)}-${st.size}"`;
      headers['etag'] = etag;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return;
      }
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}
