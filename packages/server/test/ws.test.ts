/**
 * WS 传输层集成测试（真实 ws 客户端，随机端口，:memory: 库）。
 *
 * 防 flake 核心：每连接一个"类型过滤缓冲队列"——nextMessage(type, pred?) 先扫已收队列取
 * 最早的匹配消息，未匹配则挂等待；广播时序（room_state/snapshot/action_applied 交错）不再
 * 依赖到达顺序假设。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createGameServer, type GameServer } from '../src/ws.js';

/** 收到的协议消息（测试里宽松看待字段）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = { type: string; [k: string]: any };

interface Waiter {
  pred: (m: Msg) => boolean;
  resolve: (m: Msg) => void;
  timer: NodeJS.Timeout;
}

class TestClient {
  readonly received: Msg[] = [];
  private readonly queue: Msg[] = [];
  private readonly waiters: Waiter[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Msg;
      this.received.push(msg);
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx === -1) {
        this.queue.push(msg);
        return;
      }
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
    });
  }

  static async connect(
    port: number,
    path = '/ws',
    options?: { autoPong?: boolean },
  ): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      autoPong: options?.autoPong ?? true,
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    return new TestClient(ws);
  }

  /** 发消息；给 awaitType 时等该类型的最早匹配消息。 */
  send(msg: Record<string, unknown>): void;
  send(msg: Record<string, unknown>, awaitType: string): Promise<Msg>;
  send(msg: Record<string, unknown>, awaitType?: string): void | Promise<Msg> {
    this.ws.send(JSON.stringify(msg));
    if (awaitType === undefined) return;
    return this.nextMessage(awaitType);
  }

  /** 取指定类型（可再加谓词）的最早消息；已收队列优先，否则等待。 */
  nextMessage(type: string, pred?: (m: Msg) => boolean, timeoutMs = 5000): Promise<Msg> {
    const matches = (m: Msg): boolean => m.type === type && (pred === undefined || pred(m));
    const idx = this.queue.findIndex(matches);
    if (idx !== -1) return Promise.resolve(this.queue.splice(idx, 1)[0]!);
    return new Promise<Msg>((resolve, reject) => {
      const waiter: Waiter = {
        pred: matches,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i !== -1) this.waiters.splice(i, 1);
          reject(
            new Error(
              `等待 ${type} 超时；已收类型: ${this.received.map((m) => m.type).join(',') || '(无)'}`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  waitClose(timeoutMs = 3000): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitClose 超时')), timeoutMs);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = this.waitClose();
    this.ws.close();
    await closed;
  }
}

const servers: GameServer[] = [];
const clients: TestClient[] = [];

async function startTestServer(extra?: {
  staticDir?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}): Promise<GameServer> {
  const server = await createGameServer({ port: 0, dbPath: ':memory:', ...extra });
  servers.push(server);
  return server;
}

async function connect(port: number, options?: { autoPong?: boolean }): Promise<TestClient> {
  const client = await TestClient.connect(port, '/ws', options);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
});

interface TwoPlayerSetup {
  a: TestClient;
  b: TestClient;
  credA: Msg;
  credB: Msg;
  snapA: Msg;
  snapB: Msg;
  code: string;
}

/** a 建房（2p, seed 7）、b 加入、a 开局；返回双方 credentials 与开局快照。 */
async function setupTwoPlayerGame(port: number): Promise<TwoPlayerSetup> {
  const a = await connect(port);
  const b = await connect(port);
  const credA = await a.send(
    { type: 'create_room', protocolVersion: 1, nickname: 'A', config: { playerCount: 2, seed: 7 } },
    'credentials',
  );
  const roomA = await a.nextMessage('room_state');
  const code = roomA.room.code as string;
  const credB = await b.send(
    { type: 'join_room', protocolVersion: 1, code, nickname: 'B' },
    'credentials',
  );
  await a.send({ type: 'start_game', protocolVersion: 1, token: credA.token });
  const snapA = await a.nextMessage('snapshot');
  const snapB = await b.nextMessage('snapshot');
  return { a, b, credA, credB, snapA, snapB, code };
}

describe('WebSocket 传输层', () => {
  it('two clients create/join/start/play one action', async () => {
    const server = await startTestServer();
    const { a, b, credA, credB, snapA, snapB } = await setupTwoPlayerGame(server.port);
    expect(credA.seat).toBe(0);
    expect(credB.seat).toBe(1);

    // 当前行动方由引擎顺位决定（seed 洗牌），取 legalActions 非空的一方
    const actorIsA = (snapA.legalActions as unknown[]).length > 0;
    const [actor, other, token, snap] = actorIsA
      ? [a, b, credA.token as string, snapA]
      : [b, a, credB.token as string, snapB];
    expect(snap.legalActions.length).toBeGreaterThan(0);

    await actor.send({
      type: 'submit_action',
      protocolVersion: 1,
      token,
      action: snap.legalActions[0],
    });
    const applied = await other.nextMessage('action_applied');
    expect(applied.seq).toBe(0);
    expect(applied.player).toBe(actorIsA ? 0 : 1);
    // 行动后每人收到新视角快照，seq 推进
    const follow = await other.nextMessage('snapshot');
    expect(follow.seq).toBe(1);
  });

  it('room_state never carries tokens (broadcast safety)', async () => {
    const server = await startTestServer();
    const { a, b, credA, credB } = await setupTwoPlayerGame(server.port);
    for (const client of [a, b]) {
      for (const m of client.received.filter((x) => x.type === 'room_state')) {
        const json = JSON.stringify(m);
        expect(json).not.toContain('"token"');
        expect(json).not.toContain(credA.token);
        expect(json).not.toContain(credB.token);
        // config.seed 同样不广播（防推算洗牌），只留 customSeed 公开标记
        expect(m.room.config.seed).toBeUndefined();
        expect(m.room.customSeed).toBe(true);
      }
      // 确认确实收到过 room_state（防空断言通过）
      expect(client.received.some((x) => x.type === 'room_state')).toBe(true);
    }
  });

  it('resume returns seat and snapshot after disconnect（开局后）', async () => {
    const server = await startTestServer();
    const { a, b, credA } = await setupTwoPlayerGame(server.port);

    await a.close();
    // 断线广播：座位 0 connected=false
    const rsOff = await b.nextMessage(
      'room_state',
      (m) => m.room.seats[0]?.connected === false,
    );
    expect(rsOff.room.seats[1].connected).toBe(true);

    // 新连接凭 token resume：回 credentials + snapshot，广播 connected=true
    const a2 = await connect(server.port);
    const cred = await a2.send(
      { type: 'resume', protocolVersion: 1, token: credA.token },
      'credentials',
    );
    expect(cred.seat).toBe(0);
    expect(cred.token).toBe(credA.token);
    const snap = await a2.nextMessage('snapshot');
    expect(snap.seq).toBe(0);
    expect(snap.state.players[0].hand.kind).toBe('full');
    await b.nextMessage('room_state', (m) => m.room.seats[0]?.connected === true);
  });

  it('resume before start returns original seat（开局前走内存房间）', async () => {
    const server = await startTestServer();
    const a = await connect(server.port);
    const credA = await a.send(
      {
        type: 'create_room',
        protocolVersion: 1,
        nickname: 'A',
        config: { playerCount: 3, seed: 7 },
      },
      'credentials',
    );
    await a.close();

    const a2 = await connect(server.port);
    const cred = await a2.send(
      { type: 'resume', protocolVersion: 1, token: credA.token },
      'credentials',
    );
    expect(cred.seat).toBe(0);
    expect(cred.token).toBe(credA.token);
    const rs = await a2.nextMessage('room_state');
    expect(rs.yourSeat).toBe(0);
    expect(rs.room.seats[0].connected).toBe(true);
    expect(rs.room.started).toBe(false);
  });

  it('protocolVersion mismatch gets error', async () => {
    const server = await startTestServer();
    const a = await connect(server.port);
    const err = await a.send({ type: 'ping', protocolVersion: 2 }, 'error');
    expect(err.code).toBe('protocol-mismatch');
    const err2 = await a.send(
      { type: 'create_room', protocolVersion: 0, nickname: 'A', config: { playerCount: 2 } },
      'error',
    );
    expect(err2.code).toBe('protocol-mismatch');
    // 版本正确则正常回 pong
    const pong = await a.send({ type: 'ping', protocolVersion: 1 }, 'pong');
    expect(pong.protocolVersion).toBe(1);
  });

  it('无效 token：resume/submit_action 回 invalid-token', async () => {
    const server = await startTestServer();
    const a = await connect(server.port);
    const err = await a.send({ type: 'resume', protocolVersion: 1, token: 'bogus' }, 'error');
    expect(err.code).toBe('invalid-token');
    const err2 = await a.send(
      { type: 'submit_action', protocolVersion: 1, token: 'bogus', action: { type: 'pass', cardId: 'x' } },
      'error',
    );
    expect(err2.code).toBe('invalid-token');
  });

  it('submit_action 的 token 绑定座位：非当前玩家提交回 not-your-turn（防代打）', async () => {
    const server = await startTestServer();
    const { a, b, credA, credB, snapA } = await setupTwoPlayerGame(server.port);
    // 拿当前玩家的合法行动，用另一方的 token 提交——token → seat 映射决定身份，
    // 即便行动本身合法也因 not-your-turn 被拒，绝不能以对方座位落子
    const actorIsA = (snapA.legalActions as unknown[]).length > 0;
    const [idle, idleToken, action] = actorIsA
      ? [b, credB.token as string, snapA.legalActions[0]]
      : [a, credA.token as string, snapA.legalActions[0]];
    const err = await idle.send(
      { type: 'submit_action', protocolVersion: 1, token: idleToken, action },
      'error',
    );
    expect(err.code).toBe('not-your-turn');

    // 房间未开局时 token 属于大厅座位，submit 回 not-started
    const c = await connect(server.port);
    const credC = await c.send(
      { type: 'create_room', protocolVersion: 1, nickname: 'C', config: { playerCount: 2 } },
      'credentials',
    );
    const err2 = await c.send(
      { type: 'submit_action', protocolVersion: 1, token: credC.token, action },
      'error',
    );
    expect(err2.code).toBe('not-started');
  });

  it('非法 JSON 与未知消息类型回 error', async () => {
    const server = await startTestServer();
    const a = await connect(server.port);
    a.ws.send('not json{');
    const err = await a.nextMessage('error');
    expect(err.code).toBe('bad-message');
    const err2 = await a.send({ type: 'explode', protocolVersion: 1 }, 'error');
    expect(err2.code).toBe('unknown-message');
  });

  it('upgrade 只接受 /ws（其余 426）；无 staticDir 时 HTTP GET 404', async () => {
    const server = await startTestServer();
    await expect(TestClient.connect(server.port, '/nope')).rejects.toThrow(/426/);
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(404);
  });

  it('staticDir 托管静态文件：/ 回 index.html，拒绝路径穿越', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brass-static-'));
    try {
      await writeFile(join(dir, 'index.html'), '<h1>brass-web</h1>');
      const server = await startTestServer({ staticDir: dir });

      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('brass-web');

      const missing = await fetch(`http://127.0.0.1:${server.port}/missing.js`);
      expect(missing.status).toBe(404);

      // %2e%2e 解码后为 ..，resolve 出根目录必须拒绝
      const traversal = await fetch(`http://127.0.0.1:${server.port}/%2e%2e/%2e%2e/etc/hostname`);
      expect(traversal.status).toBe(404);

      // 静态托管与 /ws 同端口共存
      const a = await connect(server.port);
      const pong = await a.send({ type: 'ping', protocolVersion: 1 }, 'pong');
      expect(pong.type).toBe('pong');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('心跳：不回 pong 的连接被服务器断开', async () => {
    const server = await startTestServer({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 250 });
    const c = await connect(server.port, { autoPong: false });
    await c.waitClose(3000);
    expect(c.ws.readyState).toBe(WebSocket.CLOSED);
  });
});
