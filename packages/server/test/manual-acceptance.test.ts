/**
 * M2 手动验收清单的脚本化替代（Task 13 Step 1）：可重复执行的验收证据。
 *
 * brief 清单逐项映射：
 * - 建房 → 加入 → 开始：test 1（含房间号格式、customSeed 公开标记、广播 config 不含 seed、
 *   任意座位可开局、开局快照合法行动仅当前玩家非空）。
 * - 各行动类型：test 3——两局固定种子随机对局（3p + 4p），从 actions 表统计行动类型
 *   直方图并断言七类全覆盖（sell 需加权选取，见 pickAction 注释）。
 * - 打完一局 → 终局：test 2 / 3 均打到 game_over（winner 非空、finalScores 覆盖全员）。
 * - 刷新重连：test 2——对局中断线 → 他端广播 connected=false → 新连接 resume 恢复原
 *   座位与当前快照 → 广播 connected=true → 继续打到终局。
 * - 历史对局落库：test 2 / 3 终局后只读连接核对 games/actions 表。
 *
 * 与 e2e.test.ts 的分工：e2e 锚定 seq 连续性/落库逐字节/隐藏信息；本文件锚定"人工验收
 * 清单"的每一步都有自动化对应，两局行动类型直方图打印到 stdout 供报告引用。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { LINKS, MERCHANTS, createRng, type Rng } from '@brass/engine';
import { createTestHarness, type TestClient } from './helpers.js';

const harness = createTestHarness();
let tmpDir: string | null = null;

afterEach(async () => {
  await harness.cleanup();
  if (tmpDir !== null) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

const PER_STEP_TIMEOUT_MS = 30_000;

const MERCHANT_IDS = new Set(Object.keys(MERCHANTS));

/**
 * 随机选行动,按卖前置链加权:sell 合法优先(需已建可卖产业 + 商人需求 +
 * 啤酒,随机对局很少走到);build 偏向可卖产业与酒厂;network 偏向端点含
 * 商人位的连线(打开卖货连通)。仍由种子 RNG 驱动,测试确定性。
 */
function pickAction(legal: Record<string, unknown>[], rng: Rng): Record<string, unknown> {
  const ofType = (t: string): Record<string, unknown>[] => legal.filter((a) => a.type === t);
  const sells = ofType('sell');
  if (sells.length > 0 && rng.next() < 0.7) return sells[rng.nextInt(sells.length)]!;
  const builds = ofType('build');
  if (builds.length > 0 && rng.next() < 0.7) {
    const sellable = builds.filter((a) =>
      ['cotton', 'manufacturer', 'pottery', 'brewery'].includes(String(a.industry)),
    );
    const pool = sellable.length > 0 ? sellable : builds;
    return pool[rng.nextInt(pool.length)]!;
  }
  const networks = ofType('network');
  if (networks.length > 0 && rng.next() < 0.5) {
    const merchanty = networks.filter((a) =>
      (a.links as number[]).some((li) => {
        const l = LINKS[li]!;
        return MERCHANT_IDS.has(l.a) || MERCHANT_IDS.has(l.b);
      }),
    );
    const pool = merchanty.length > 0 ? merchanty : networks;
    return pool[rng.nextInt(pool.length)]!;
  }
  return legal[rng.nextInt(legal.length)]!;
}

interface PlayResult {
  /** 本局行动总数（= 终局 seq）。 */
  total: number;
  /** 行动类型直方图（按 action_applied 顺序统计）。 */
  histogram: Record<string, number>;
}

/** 推进 n 步随机行动（各端独立确定性 RNG），返回下一个 seq。 */
async function playSteps(
  clients: TestClient[],
  tokens: string[],
  fromSeq: number,
  steps: number,
  rngSalt: number,
): Promise<number> {
  let seq = fromSeq;
  for (let i = 0; i < steps; i++) {
    const snaps = await Promise.all(
      clients.map((c) => c.nextMessage('snapshot', (m) => m.seq === seq, PER_STEP_TIMEOUT_MS)),
    );
    // turnHold 协议:被扣住的座位先显式结束回合(同一 seq 的确认后快照随后到达)
    let confirmed = false;
    for (let k = 0; k < clients.length; k++) {
      if (snaps[k]!.turnHold === k) {
        clients[k]!.send({ type: 'end_turn', protocolVersion: 1, token: tokens[k]! });
        confirmed = true;
      }
    }
    if (confirmed) {
      i--;
      continue;
    }
    const actorIdx = snaps.findIndex((s) => (s.legalActions as unknown[]).length > 0);
    expect(actorIdx, `seq ${seq} 应有一方有合法行动`).toBeGreaterThanOrEqual(0);
    const legal = snaps[actorIdx]!.legalActions as Record<string, unknown>[];
    const rng = createRng(rngSalt + seq * 131 + actorIdx);
    const action = pickAction(legal, rng);
    clients[actorIdx]!.send({
      type: 'submit_action',
      protocolVersion: 1,
      token: tokens[actorIdx]!,
      action,
    });
    const applied = await clients[actorIdx]!.nextMessage(
      'action_applied',
      (m) => m.seq === seq,
      PER_STEP_TIMEOUT_MS,
    );
    expect(applied.player).toBe(actorIdx);
    seq++;
  }
  return seq;
}

/** 从 fromSeq 打到终局；返回行动总数与类型直方图。确定性（rngSalt 固定）。 */
async function playToEnd(
  clients: TestClient[],
  tokens: string[],
  fromSeq: number,
  rngSalt: number,
): Promise<PlayResult> {
  const histogram: Record<string, number> = {};
  let seq = fromSeq;
  for (;;) {
    const snaps = await Promise.all(
      clients.map((c) => c.nextMessage('snapshot', (m) => m.seq === seq, PER_STEP_TIMEOUT_MS)),
    );
    // turnHold 协议:被扣住的座位先显式结束回合(同一 seq 的确认后快照随后到达)
    let confirmed = false;
    for (let k = 0; k < clients.length; k++) {
      if (snaps[k]!.turnHold === k) {
        clients[k]!.send({ type: 'end_turn', protocolVersion: 1, token: tokens[k]! });
        confirmed = true;
      }
    }
    if (confirmed) continue;
    const actorIdx = snaps.findIndex((s) => (s.legalActions as unknown[]).length > 0);
    if (actorIdx === -1) break; // 终局快照：全员 legalActions 为空
    const legal = snaps[actorIdx]!.legalActions as Record<string, unknown>[];
    const rng = createRng(rngSalt + seq * 131 + actorIdx);
    const action = pickAction(legal, rng);
    clients[actorIdx]!.send({
      type: 'submit_action',
      protocolVersion: 1,
      token: tokens[actorIdx]!,
      action,
    });
    const applied = await clients[actorIdx]!.nextMessage(
      'action_applied',
      (m) => m.seq === seq,
      PER_STEP_TIMEOUT_MS,
    );
    expect(applied.player).toBe(actorIdx);
    const t = (applied.action as { type: string }).type;
    histogram[t] = (histogram[t] ?? 0) + 1;
    seq++;
  }
  // 终局：全员收到 game_over，胜者非空、比分覆盖全员
  for (const c of clients) {
    const over = await c.nextMessage('game_over', undefined, PER_STEP_TIMEOUT_MS);
    expect((over.winner as unknown[]).length).toBeGreaterThan(0);
    expect(over.finalScores).toHaveLength(clients.length);
  }
  return { total: seq, histogram };
}

/** 建房 + 坐满；返回 [clients, tokens, code]。 */
async function seatRoom(
  port: number,
  playerCount: number,
  seed: number,
): Promise<{ clients: TestClient[]; tokens: string[]; code: string }> {
  const clients: TestClient[] = [];
  const tokens: string[] = [];
  const c0 = await harness.connect(port);
  clients.push(c0);
  const cred0 = await c0.send(
    {
      type: 'create_room',
      protocolVersion: 1,
      nickname: 'P0',
      config: { playerCount, seed },
    },
    'credentials',
  );
  tokens.push(cred0.token as string);
  const code = (await c0.nextMessage('room_state')).room.code as string;
  for (let i = 1; i < playerCount; i++) {
    const c = await harness.connect(port);
    clients.push(c);
    const cred = await c.send(
      { type: 'join_room', protocolVersion: 1, code, nickname: `P${i}` },
      'credentials',
    );
    expect(cred.seat).toBe(i);
    tokens.push(cred.token as string);
  }
  return { clients, tokens, code };
}

/** 只读打开库，核对一局：finished + final_state 终局相位 + actions 行数/seq 连续。 */
function assertGamePersisted(
  dbPath: string,
  expectGames: number,
): { perGame: { id: string; actions: number }[]; histogram: Record<string, number> } {
  const ro = new Database(dbPath, { readonly: true });
  try {
    const games = ro
      .prepare('SELECT id, status, final_state FROM games ORDER BY created_at, rowid')
      .all() as { id: string; status: string; final_state: string | null }[];
    expect(games).toHaveLength(expectGames);
    const perGame: { id: string; actions: number }[] = [];
    for (const g of games) {
      expect(g.status).toBe('finished');
      expect(g.final_state).not.toBeNull();
      expect((JSON.parse(g.final_state!) as { phase: string }).phase).toBe('game-over');
      const agg = ro
        .prepare(
          'SELECT COUNT(*) AS n, COUNT(DISTINCT seq) AS d, MIN(seq) AS lo, MAX(seq) AS hi FROM actions WHERE game_id = ?',
        )
        .get(g.id) as { n: number; d: number; lo: number | null; hi: number | null };
      expect(agg.d).toBe(agg.n);
      expect(agg.lo).toBe(0);
      expect(agg.hi).toBe(agg.n - 1);
      perGame.push({ id: g.id, actions: agg.n });
    }
    const histRows = ro
      .prepare(
        "SELECT json_extract(action, '$.type') AS t, COUNT(*) AS n FROM actions GROUP BY t",
      )
      .all() as { t: string; n: number }[];
    const histogram: Record<string, number> = {};
    for (const r of histRows) histogram[r.t] = r.n;
    return { perGame, histogram };
  } finally {
    ro.close();
  }
}

describe('M2 手动验收（脚本化）', () => {
  it('清单[建房→加入→开始]：房间号/种子标记/广播安全/任意座位开局/开局快照', async () => {
    const server = await harness.startServer();
    const c0 = await harness.connect(server.port);

    // 建房：3p + 自定义种子
    const cred0 = await c0.send(
      {
        type: 'create_room',
        protocolVersion: 1,
        nickname: 'Alice',
        config: { playerCount: 3, seed: 123 },
      },
      'credentials',
    );
    expect(cred0.seat).toBe(0);
    expect(typeof cred0.token).toBe('string');
    const rs0 = await c0.nextMessage('room_state');
    const room = rs0.room as {
      code: string;
      config: Record<string, unknown>;
      customSeed: boolean;
      seats: ({ nickname: string; connected: boolean } | null)[];
      started: boolean;
    };
    expect(room.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(room.customSeed).toBe(true); // 房主指定种子：公开标记
    expect(room.config).toEqual({ playerCount: 3 }); // 广播 config 不含 seed 值
    expect(room.started).toBe(false);
    expect(room.seats).toHaveLength(3);
    expect(room.seats[0]).toMatchObject({ nickname: 'Alice', connected: true });
    expect(room.seats[1]).toBeNull();
    expect(rs0.yourSeat).toBe(0);

    // 加入 ×2：双方各自收到 room_state，yourSeat 按接收端填写
    const c1 = await harness.connect(server.port);
    const cred1 = await c1.send(
      { type: 'join_room', protocolVersion: 1, code: room.code, nickname: 'Bob' },
      'credentials',
    );
    expect(cred1.seat).toBe(1);
    const rs1join = await c1.nextMessage('room_state', (m) => m.room.seats[1] !== null);
    expect(rs1join.yourSeat).toBe(1);
    expect(rs1join.room.seats[1]).toMatchObject({ nickname: 'Bob', connected: true });
    await c0.nextMessage('room_state', (m) => m.room.seats[1] !== null);

    const c2 = await harness.connect(server.port);
    const cred2 = await c2.send(
      { type: 'join_room', protocolVersion: 1, code: room.code, nickname: 'Carol' },
      'credentials',
    );
    expect(cred2.seat).toBe(2);
    await c0.nextMessage('room_state', (m) => m.room.seats[2] !== null);

    // 开始：任意座位可开局（这里用 seat 1 的 token，非房主）
    c1.send({ type: 'start_game', protocolVersion: 1, token: cred1.token as string });
    const clients = [c0, c1, c2];
    const snaps = await Promise.all(
      clients.map((c) => c.nextMessage('snapshot', (m) => m.seq === 0)),
    );
    for (const c of clients) {
      const started = await c.nextMessage('room_state', (m) => m.room.started === true);
      expect(started.room.started).toBe(true);
    }
    // 开局快照：合法行动仅当前玩家非空；其余端为空数组
    const actorIdx = snaps.findIndex((s) => (s.legalActions as unknown[]).length > 0);
    expect(actorIdx).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 3; i++) {
      const legal = snaps[i]!.legalActions as unknown[];
      if (i === actorIdx) expect(legal.length).toBeGreaterThan(0);
      else expect(legal).toEqual([]);
      // 隐藏信息：自己手牌 full，他人 count
      const state = snaps[i]!.state as {
        players: { hand: { kind: string; cards?: unknown } }[];
        turnOrder: number[];
        currentPlayerIdx: number;
      };
      expect(state.turnOrder[state.currentPlayerIdx]).toBe(actorIdx);
      for (let p = 0; p < 3; p++) {
        const hand = state.players[p]!.hand;
        if (p === i) expect(hand.kind).toBe('full');
        else {
          expect(hand.kind).toBe('count');
          expect(hand.cards).toBeUndefined();
        }
      }
    }
  });

  it(
    '清单[重连→打完一局→终局→落库]：断线广播→resume 恢复→继续到 game_over→库核对',
    { timeout: 180_000 },
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'brass-accept-'));
      const dbPath = join(tmpDir, 'accept.db');
      const server = await harness.startServer({ dbPath });

      // 2p 对局（种子固定，对局确定性）
      const { clients, tokens } = await seatRoom(server.port, 2, 7);
      const [c0, c1] = clients as [TestClient, TestClient];
      await c0.send({ type: 'start_game', protocolVersion: 1, token: tokens[0]! });

      // 先打 6 步，再断 seat 1
      let seq = await playSteps([c0, c1], tokens, 0, 6, 9_000);
      await c1.close();
      // 他端收到断线广播：seat 1 connected=false
      const offline = await c0.nextMessage(
        'room_state',
        (m) => m.room.seats[1]?.connected === false,
      );
      expect(offline.room.seats[1].nickname).toBe('P1');

      // 新连接 resume：恢复原座位 + 当前快照；他端广播 connected=true
      const c1b = await harness.connect(server.port);
      const cred = await c1b.send(
        { type: 'resume', protocolVersion: 1, token: tokens[1]! },
        'credentials',
      );
      expect(cred.seat).toBe(1);
      expect(cred.token).toBe(tokens[1]);
      // resume 快照留在队列里（playToEnd 会按 seq 取），这里仅从已收记录核对
      const snaps1b = c1b.received.filter((m) => m.type === 'snapshot');
      expect(snaps1b[snaps1b.length - 1]?.seq).toBe(seq);
      await c0.nextMessage('room_state', (m) => m.room.seats[1]?.connected === true);

      // 继续打到终局
      const result = await playToEnd([c0, c1b], tokens, seq, 9_000);
      expect(result.total).toBeGreaterThan(seq);

      // 落库核对
      const persisted = assertGamePersisted(dbPath, 1);
      expect(persisted.perGame[0]!.actions).toBe(result.total);
      console.log(
        `[验收] 重连局（2p seed=7）：共 ${result.total} 步，类型分布 ${JSON.stringify(result.histogram)}`,
      );
    },
  );

  it(
    '清单[行动类型覆盖]：3p + 4p 两局随机对局，类型直方图 + 逐局落库核对',
    { timeout: 300_000 },
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'brass-accept-'));
      const dbPath = join(tmpDir, 'accept.db');
      const server = await harness.startServer({ dbPath });

      // 局 1：3p seed=100
      const g1 = await seatRoom(server.port, 3, 100);
      await g1.clients[0]!.send({ type: 'start_game', protocolVersion: 1, token: g1.tokens[0]! });
      const r1 = await playToEnd(g1.clients, g1.tokens, 0, 11_000);
      for (const c of g1.clients) await c.close();

      // 局 2：4p seed=200
      const g2 = await seatRoom(server.port, 4, 200);
      await g2.clients[0]!.send({ type: 'start_game', protocolVersion: 1, token: g2.tokens[0]! });
      const r2 = await playToEnd(g2.clients, g2.tokens, 0, 23_000);

      // 两局都打到正常量级（与 engine fuzz 下限一致）
      expect(r1.total).toBeGreaterThan(80);
      expect(r2.total).toBeGreaterThan(100);

      // 行动类型覆盖：全部七类（build/network/develop/sell/loan/scout/pass）两局合并
      // 必须都出现（固定种子 + 固定 RNG，实测确定性复现，见报告直方图）。
      const merged: Record<string, number> = {};
      for (const h of [r1.histogram, r2.histogram]) {
        for (const [t, n] of Object.entries(h)) merged[t] = (merged[t] ?? 0) + n;
      }
      console.log(
        `[验收] 覆盖局1（3p seed=100）：${r1.total} 步 ${JSON.stringify(r1.histogram)}`,
      );
      console.log(
        `[验收] 覆盖局2（4p seed=200）：${r2.total} 步 ${JSON.stringify(r2.histogram)}`,
      );
      for (const t of ['build', 'network', 'develop', 'sell', 'loan', 'scout', 'pass']) {
        expect(merged[t], `行动类型 ${t} 应在两局随机对局中出现`).toBeGreaterThan(0);
      }

      // 落库核对：两局均 finished，actions 与客户端统计一致；库内直方图 = 客户端直方图
      const persisted = assertGamePersisted(dbPath, 2);
      expect(persisted.perGame[0]!.actions).toBe(r1.total);
      expect(persisted.perGame[1]!.actions).toBe(r2.total);
      expect(persisted.histogram).toEqual(merged);
      console.log(`[验收] 库内类型直方图：${JSON.stringify(persisted.histogram)}`);
    },
  );
});
