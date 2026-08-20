/**
 * M3 收尾 e2e（Task 6 brief Step 1）：1 真人（脚本）+ 3 AI 的 ws 级完整对局。
 *
 * aiAgentFactory 注入 HeuristicAgent（每座位一个实例，记录调用数）——不开真 API；
 * LLM 决策链已由 packages/llm 单测与 ai-seats.test.ts 的降级/兜底用例覆盖，本文件
 * 只验证"AI 座位打满整局 + 每步落库"的服务器侧闭环。
 *
 * 断言：
 * - 对局打穿到 game_over（finalScores 覆盖 4 人）；3 个 AI agent 均被实际驱动过。
 * - 真人端 action_applied seq 恰好 0..N-1 连续无重号；AI 座位的 action_applied 带
 *   reason，且因 HeuristicAgent 属降级路径一律 degraded=true；真人行动不带两字段。
 * - ai_thinking 对每个 AI 座位成对出现（true 必有 false 收尾）。
 * - 落库（:file: 临时库另开只读连接）：games status='finished' 且 final_state
 *   phase='game-over'；actions 行数 = N 且 seq 为 0..N-1；seats 4 行，3 个 AI 座位
 *   昵称带难度后缀（"AI-n（普通）"）。
 *
 * 防 flake：真人端用 ai-seats.test.ts 同款"等自己 legalActions 非空的 snapshot → 随机
 * 选一提交，与 game_over 赛跑"独立循环，不假设 AI 行动时序与 seq 对齐。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createRng, type Rng } from '@brass/engine';
import type { Action, GameState, PlayerIndex } from '@brass/engine';
import { HeuristicAgent, type DecidingAgent, type Decision } from '@brass/llm';
import { createTestHarness, type Msg, type TestClient } from './helpers.js';

const harness = createTestHarness();
let tmpDir: string | null = null;

afterEach(async () => {
  await harness.cleanup();
  if (tmpDir !== null) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

const PV = 1;
const TURN_TIMEOUT_MS = 60_000;

/** 每座位一个 HeuristicAgent 实例，记录 decide 调用数（验证 3 个 AI 均被驱动）。 */
class RecordingHeuristicAgent implements DecidingAgent {
  calls = 0;
  private readonly inner = new HeuristicAgent();

  decide(state: GameState, player: PlayerIndex, legal: Action[]): Promise<Decision> {
    this.calls += 1;
    return this.inner.decide(state, player, legal);
  }
}

/**
 * 真人端驱动循环：等到自己 legalActions 非空的 snapshot 就从合法集随机选一提交；
 * 与 game_over 赛跑收尾（同 ai-seats.test.ts driveOneHuman 模式，waiter 只注册一次——
 * game_over 被本循环的 waiter 消费，故作为返回值交出，调用方不得再 nextMessage 等它）。
 */
async function driveHumanUntilGameOver(
  client: TestClient,
  token: string,
  rng: Rng,
): Promise<Msg> {
  const overP = client.nextMessage('game_over', undefined, TURN_TIMEOUT_MS * 4).then(
    (m) => ({ kind: 'over' as const, m }),
    () => ({ kind: 'over-timeout' as const }),
  );
  for (;;) {
    const snapP = client
      .nextMessage(
        'snapshot',
        (m) => m.turnHold != null || (m.legalActions as unknown[]).length > 0,
        TURN_TIMEOUT_MS,
      )
      .then(
        (m) => ({ kind: 'snap' as const, m }),
        () => ({ kind: 'stuck' as const }),
      );
    const r = await Promise.race([snapP, overP]);
    if (r.kind === 'over') return r.m;
    if (r.kind === 'over-timeout') throw new Error('等 game_over 超时');
    if (r.kind === 'stuck') throw new Error('等自己回合 snapshot 超时（对局卡死）');
    // turnHold 协议:回合打满被扣住 → 显式结束回合,driveAI 才继续
    if (r.m.turnHold != null) {
      client.send({ type: 'end_turn', protocolVersion: PV, token });
      continue;
    }
    const legal = r.m.legalActions as Record<string, unknown>[];
    client.send({
      type: 'submit_action',
      protocolVersion: PV,
      token,
      action: legal[rng.nextInt(legal.length)]!,
    });
  }
}

describe('ai-e2e: 1 真人 + 3 AI（HeuristicAgent 注入）ws 级完整对局', () => {
  it(
    '打穿到 game_over：seq 连续、AI 行动带 reason/degraded、games/actions/seats 落库完整',
    { timeout: 180_000 },
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'brass-ai-e2e-'));
      const dbPath = join(tmpDir, 'ai-e2e.db');
      const agents = new Map<PlayerIndex, RecordingHeuristicAgent>();
      const server = await harness.startServer({
        dbPath,
        aiAgentFactory: (seat) => {
          const a = new RecordingHeuristicAgent();
          agents.set(seat, a);
          return a;
        },
      });

      // ---- 建房开局：真人 create（4p、固定种子、3 AI 普通难度）→ start ----
      const human = await harness.connect(server.port);
      const cred = await human.send(
        {
          type: 'create_room',
          protocolVersion: PV,
          nickname: '真人',
          config: { playerCount: 4, seed: 42, aiSeats: { count: 3, difficulty: 'normal' } },
        },
        'credentials',
      );
      expect(cred.seat).toBe(0);
      const token = cred.token as string;
      await human.send({ type: 'start_game', protocolVersion: PV, token });

      // ---- 真人脚本驱动到 game_over ----
      const over = await driveHumanUntilGameOver(human, token, createRng(8_000));
      expect((over.winner as unknown[]).length).toBeGreaterThan(0);
      expect(over.finalScores).toHaveLength(4);

      // ---- 断言 1：3 个 AI 座位各拿到 agent 且均被实际驱动 ----
      expect([...agents.keys()].sort()).toEqual([1, 2, 3]);
      for (const a of agents.values()) expect(a.calls).toBeGreaterThan(0);

      const msgs = human.received;

      // ---- 断言 2：action_applied seq 连续无重号；AI 行动带 reason+degraded，真人不带 ----
      const applied = msgs.filter((m) => m.type === 'action_applied');
      const totalActions = applied.length;
      expect(totalActions).toBeGreaterThan(100); // 4p 完整局下限（与 e2e/engine fuzz 一致）
      expect(applied.map((m) => m.seq)).toEqual(
        Array.from({ length: totalActions }, (_, i) => i),
      );
      for (const seat of [1, 2, 3]) {
        const aiApplied = applied.filter((m) => m.player === seat);
        expect(aiApplied.length, `seat ${seat} 应有行动`).toBeGreaterThan(0);
        for (const m of aiApplied) {
          expect(typeof m.reason).toBe('string');
          // HeuristicAgent 决策属降级路径 → degraded=true
          expect(m.degraded).toBe(true);
        }
      }
      const humanApplied = applied.filter((m) => m.player === 0);
      expect(humanApplied.length).toBeGreaterThan(0);
      for (const m of humanApplied) {
        expect(m.reason).toBeUndefined();
        expect(m.degraded).toBeUndefined();
      }

      // ---- 断言 3：ai_thinking 对 AI 座位成对（true 必有 false 收尾） ----
      const thinking = msgs.filter((m) => m.type === 'ai_thinking');
      expect(thinking.length).toBeGreaterThan(0);
      const trues = new Set(thinking.filter((m) => m.thinking === true).map((m) => m.seat));
      const falses = thinking.filter((m) => m.thinking === false).map((m) => m.seat);
      for (const seat of [1, 2, 3]) expect(trues.has(seat)).toBe(true);
      for (const seat of trues) expect(falses).toContain(seat);

      // ---- 断言 4：落库——games finished + final_state；actions 行数/seq；seats 4 行 ----
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
        // AI 行动与真人行动走同一条落库路径
        const aiRows = ro
          .prepare('SELECT COUNT(DISTINCT player) AS p FROM actions WHERE player IN (1,2,3)')
          .get() as { p: number };
        expect(aiRows.p).toBe(3);
        const seatRows = ro
          .prepare('SELECT seat, nickname FROM seats ORDER BY seat')
          .all() as { seat: number; nickname: string }[];
        expect(seatRows).toHaveLength(4);
        expect(seatRows[0]).toEqual({ seat: 0, nickname: '真人' });
        for (let i = 1; i < 4; i++) {
          expect(seatRows[i]).toEqual({ seat: i, nickname: `AI-${i}（普通）` });
        }
      } finally {
        ro.close();
      }
    },
  );
});
