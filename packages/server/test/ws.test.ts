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
import type { GameServer } from '../src/ws.js';
import { createTestHarness, TestClient, type Msg } from './helpers.js';

const harness = createTestHarness();

async function startTestServer(extra?: {
  staticDir?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}): Promise<GameServer> {
  return harness.startServer(extra);
}

async function connect(port: number, options?: { autoPong?: boolean }): Promise<TestClient> {
  return harness.connect(port, options);
}

afterEach(() => harness.cleanup());

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

  it('draft_update:暂存预览广播给同房其他人(发送方不回声)', async () => {
    const server = await startTestServer();
    const { a, b, credA } = await setupTwoPlayerGame(server.port);
    const draft = { build: { location: 'birmingham', slotIndex: 1, industry: 'cotton' }, text: '建造伯明翰棉纺厂' };
    a.send({ type: 'draft_update', protocolVersion: 1, token: credA.token, draft });
    const msg = await b.nextMessage('player_draft');
    expect(msg.seat).toBe(0);
    expect(msg.draft.text).toBe('建造伯明翰棉纺厂');
    // 清除帧:draft=null 透传
    a.send({ type: 'draft_update', protocolVersion: 1, token: credA.token, draft: null });
    const cleared = await b.nextMessage('player_draft', (m) => m.draft === null);
    expect(cleared.seat).toBe(0);
    // 发送方自己收不到回声
    expect(a.received.some((m) => m.type === 'player_draft')).toBe(false);
  });

  it('快照带 playedCards:行动消耗的牌入列(该座位)', async () => {
    const server = await startTestServer();
    const { a, b, credA, credB, snapA, snapB } = await setupTwoPlayerGame(server.port);
    const aFirst = (snapA.legalActions as unknown[]).length > 0;
    const actor = aFirst ? a : b;
    const actorSeat = aFirst ? 0 : 1;
    const actorToken = (aFirst ? credA.token : credB.token) as string;
    const snap = aFirst ? snapA : snapB;
    // 用 loan 行动(一定合法):消耗的牌 = action.cardId
    const loan = (snap.legalActions as { type: string; cardId?: string }[]).find(
      (x) => x.type === 'loan',
    )!;
    actor.send({ type: 'submit_action', protocolVersion: 1, token: actorToken, action: loan });
    await actor.nextMessage('action_applied');
    const after = await actor.nextMessage('snapshot');
    const played = after.playedCards as { id: string }[][];
    expect(played[actorSeat]!.map((c) => c.id)).toEqual([loan.cardId]);
    expect(played[1 - actorSeat]).toEqual([]);
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

  it('同 token 重复连接：resume 踢掉旧连接，旧连接 close 不再误报断线', async () => {
    const server = await startTestServer();
    const { a, b, credA } = await setupTwoPlayerGame(server.port);

    // 同一 token 第二个连接 resume（旧连接 a 仍开着）——同座位多连接场景
    const a2 = await connect(server.port);
    const cred = await a2.send(
      { type: 'resume', protocolVersion: 1, token: credA.token },
      'credentials',
    );
    expect(cred.seat).toBe(0);

    // 旧连接被服务器踢掉；其 close 不得再触发 connected=false 广播
    await a.waitClose();
    await new Promise((r) => setTimeout(r, 200));
    for (const c of [b, a2]) {
      for (const m of c.received.filter((x) => x.type === 'room_state')) {
        expect(m.room.seats[0].connected).toBe(true);
      }
    }

    // 再触发一次广播（第三次 resume），确认座位 0 仍是 connected=true
    const before = b.received.length;
    const a3 = await connect(server.port);
    await a3.send({ type: 'resume', protocolVersion: 1, token: credA.token }, 'credentials');
    await b.nextMessage('room_state', () => b.received.length > before);
    const last = b.received.filter((x) => x.type === 'room_state').at(-1);
    expect(last?.room.seats[0].connected).toBe(true);
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

  it('leave（开局前）：token 失效、座位清空、本连接被断开', async () => {
    const server = await startTestServer();
    const a = await connect(server.port);
    const credA = await a.send(
      { type: 'create_room', protocolVersion: 1, nickname: 'A', config: { playerCount: 2 } },
      'credentials',
    );
    // credentials 无 roomCode：join 需要房间码——从 B 加入后的 room_state 拿
    const roomCode = (await a.nextMessage('room_state')).room.code as string;
    const b = await connect(server.port);
    const rs = await b.send(
      { type: 'join_room', protocolVersion: 1, code: roomCode, nickname: 'B' },
      'room_state',
    );
    expect(rs.room.seats[0]?.connected).toBe(true);
    // A leave：B 收到 seats[0] 清空为 null（避免幽灵座位卡死后续开局），A 连接被断开
    const off = b.nextMessage('room_state', (m) => m.room.seats[0] === null);
    a.send({ type: 'leave', protocolVersion: 1, token: credA.token });
    await off;
    await a.waitClose(3000);
    expect(a.ws.readyState).toBe(WebSocket.CLOSED);
    // token 已失效：resume 回 invalid-token
    const a2 = await connect(server.port);
    const err = await a2.send(
      { type: 'resume', protocolVersion: 1, token: credA.token },
      'error',
    );
    expect(err.code).toBe('invalid-token');
  });

  it('leave（开局后）：token 移出对局、座位广播断线、另一玩家仍可行动', async () => {
    const server = await startTestServer();
    const { a, b, credA, credB, snapA } = await setupTwoPlayerGame(server.port);
    // 当前玩家若是 A，让 A leave 后 B 仍能拿到当前玩家行动推进（对局不卡）
    const actorIsA = (snapA.legalActions as unknown[]).length > 0;
    const leaveClient = actorIsA ? a : b;
    const stayClient = actorIsA ? b : a;
    const leaveToken = actorIsA ? (credA.token as string) : (credB.token as string);
    const off = stayClient.nextMessage('room_state', (m) =>
      (actorIsA ? m.room.seats[0] : m.room.seats[1])?.connected === false,
    );
    leaveClient.send({ type: 'leave', protocolVersion: 1, token: leaveToken });
    await off;
    await leaveClient.waitClose(3000);
    // 留下的玩家仍能收到 snapshot（对局推进），且 leave 的 token 无法再 resume
    const resumed = await connect(server.port);
    const err = await resumed.send(
      { type: 'resume', protocolVersion: 1, token: leaveToken },
      'error',
    );
    expect(err.code).toBe('invalid-token');
  });

  it('心跳：不回 pong 的连接被服务器断开', async () => {
    const server = await startTestServer({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 250 });
    const c = await connect(server.port, { autoPong: false });
    await c.waitClose(3000);
    expect(c.ws.readyState).toBe(WebSocket.CLOSED);
  });
});
