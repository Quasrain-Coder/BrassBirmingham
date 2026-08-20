/**
 * 服务器端到端（ws 级完整对局，Task 7 验收）。
 *
 * 4 个真实 ws 客户端建房 → 开局 → 各座位收到 snapshot 后用**各自独立的 RNG** 从
 * legalActions 均匀随机选一个行动提交，直到 game_over。服务端每步落库（:file: 临时库，
 * 测试另开只读连接断言）。
 *
 * 断言（brief Step 1）：
 * - 每客户端收到的 action_applied seq 恰好是 0..N-1 连续无重号（ws 有序 + 单行动驱动）。
 * - 终局 games 表 status='finished' 且 final_state 存在（phase='game-over'）。
 * - actions 行数 = seq 总数 N，且 seq 互不重叠。
 * - 隐藏信息：任何 snapshot 中他人手牌只有 {kind:'count'}；抽查开局快照（seq 0，尚无
 *   卡牌公开）序列化不含他人初始手牌 cardId。
 *
 * 单行动驱动防 flake：每一步等齐 4 客户端 seq 一致的 snapshot 再行动，天然无并发竞态。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createRng, type Rng } from '@brass/engine';
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

/** 抽某客户端最新 snapshot 里自己手牌（kind==='full'）的 cardId 列表。 */
function ownHandCardIds(client: TestClient): string[] {
  const snap = client.received.find(
    (m) => m.type === 'snapshot' && m.state.players[m.seatHint]?.hand?.kind === 'full',
  );
  if (snap === undefined) return [];
  return (snap.state.players[snap.seatHint].hand.cards as { id: string }[]).map((c) => c.id);
}

describe('e2e: ws 级完整对局', () => {
  it(
    '4 客户端随机打完整局：seq 连续、落库完整、他人手牌不可见',
    { timeout: 120_000 },
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'brass-e2e-'));
      const dbPath = join(tmpDir, 'e2e.db');
      const server = await harness.startServer({ dbPath });

      // ---- 建房：c0 create(4p, 固定种子) + c1..c3 join + c0 start ----
      const clients: TestClient[] = [];
      const tokens: string[] = [];
      const c0 = await harness.connect(server.port);
      clients.push(c0);
      const cred0 = await c0.send(
        {
          type: 'create_room',
          protocolVersion: 1,
          nickname: 'P0',
          config: { playerCount: 4, seed: 42 },
        },
        'credentials',
      );
      tokens.push(cred0.token as string);
      const code = (await c0.nextMessage('room_state')).room.code as string;
      for (let i = 1; i < 4; i++) {
        const c = await harness.connect(server.port);
        clients.push(c);
        const cred = await c.send(
          { type: 'join_room', protocolVersion: 1, code, nickname: `P${i}` },
          'credentials',
        );
        expect(cred.seat).toBe(i);
        tokens.push(cred.token as string);
      }
      expect(new Set(tokens).size).toBe(4);
      await c0.send({ type: 'start_game', protocolVersion: 1, token: tokens[0]! });

      // 每客户端独立 RNG（固定种子，测试可复现）
      const rngs: Rng[] = clients.map((_, seat) => createRng(10_000 + seat));

      // ---- 主循环：等齐 4 端 seq 一致的 snapshot → 行动方随机选一 → 等 action_applied ----
      let seq = 0;
      for (;;) {
        const snaps = await Promise.all(
          clients.map((c) =>
            c.nextMessage('snapshot', (m) => m.seq === seq, PER_STEP_TIMEOUT_MS),
          ),
        );
        // turnHold 协议:被扣住的座位先显式结束回合(同一 seq 的确认后快照随后到达)
        let confirmed = false;
        for (let i = 0; i < clients.length; i++) {
          if (snaps[i]!.turnHold === i) {
            clients[i]!.send({ type: 'end_turn', protocolVersion: 1, token: tokens[i]! });
            confirmed = true;
          }
        }
        if (confirmed) continue;
        const actorIdx = snaps.findIndex((s) => (s.legalActions as unknown[]).length > 0);
        if (actorIdx === -1) break; // 终局快照：全员 legalActions 为空
        const legal = snaps[actorIdx]!.legalActions as Record<string, unknown>[];
        const action = legal[rngs[actorIdx]!.nextInt(legal.length)]!;
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
      const totalActions = seq;
      expect(totalActions).toBeGreaterThan(100); // 4p 完整局下限（与 engine fuzz 一致）

      // 全员收到 game_over，胜者非空、比分覆盖 4 人
      for (const c of clients) {
        const over = await c.nextMessage('game_over', undefined, PER_STEP_TIMEOUT_MS);
        expect((over.winner as unknown[]).length).toBeGreaterThan(0);
        expect(over.finalScores).toHaveLength(4);
      }

      // ---- 断言 1：每客户端 action_applied seq 恰好 0..N-1 连续无重号 ----
      const expectedSeqs = Array.from({ length: totalActions }, (_, i) => i);
      for (const c of clients) {
        const seqs = c.received.filter((m) => m.type === 'action_applied').map((m) => m.seq);
        expect(seqs).toEqual(expectedSeqs);
      }

      // ---- 断言 2：games 表 finished + final_state；actions 行数 = seq 总数 ----
      const ro = new Database(dbPath, { readonly: true });
      try {
        const game = ro
          .prepare('SELECT status, final_state FROM games')
          .get() as { status: string; final_state: string | null };
        expect(game.status).toBe('finished');
        expect(game.final_state).not.toBeNull();
        expect((JSON.parse(game.final_state!) as { phase: string }).phase).toBe('game-over');
        const agg = ro
          .prepare(
            'SELECT COUNT(*) AS n, COUNT(DISTINCT seq) AS d, MIN(seq) AS lo, MAX(seq) AS hi FROM actions',
          )
          .get() as { n: number; d: number; lo: number; hi: number };
        expect(agg.n).toBe(totalActions);
        expect(agg.d).toBe(totalActions);
        expect(agg.lo).toBe(0);
        expect(agg.hi).toBe(totalActions - 1);
      } finally {
        ro.close();
      }

      // ---- 断言 3：隐藏信息——他人手牌在任何 snapshot 中不可见 ----
      // 给 snapshot 打上座位标记（credentials 顺序 = 座位），供抽查用
      for (let seat = 0; seat < 4; seat++) {
        for (const m of clients[seat]!.received) {
          if (m.type === 'snapshot') m.seatHint = seat;
        }
      }
      const initialHandIds = clients.map((c) => ownHandCardIds(c));
      for (const ids of initialHandIds) expect(ids.length).toBeGreaterThan(0);
      for (let seat = 0; seat < 4; seat++) {
        const snapshots = clients[seat]!.received.filter((m) => m.type === 'snapshot');
        expect(snapshots.length).toBeGreaterThan(0);
        for (const snap of snapshots) {
          for (let other = 0; other < 4; other++) {
            if (other === seat) continue;
            const hand = snap.state.players[other].hand;
            // 结构性断言：他人手牌只剩张数
            expect(hand.kind, `seat${seat} snapshot 里 seat${other} 手牌`).toBe('count');
            expect(hand.cards).toBeUndefined();
          }
        }
        // 抽查开局快照（seq 0，尚无卡牌公开）：其余三人的初始手牌 cardId 一个都不出现。
        // 注：牌打出后 cardId 经 lastEvents / discard.top 公开（Brass 规则允许），
        // 故序列化扫描只适用于开局快照。
        const opening = snapshots.find((m) => m.seq === 0);
        expect(opening).toBeDefined();
        const serialized = JSON.stringify(opening!.state);
        for (let other = 0; other < 4; other++) {
          if (other === seat) continue;
          for (const id of initialHandIds[other]!) {
            expect(serialized, `seat${seat} 的开局 snapshot 泄漏了 seat${other} 的 ${id}`).not.toContain(
              id,
            );
          }
        }
      }
    },
  );
});
