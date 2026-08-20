/**
 * bench harness 单测（入 CI，不烧 token——LLMAgent 接 FixtureClient）。
 *
 * 断言三件事：
 * 1. driveGame 驱动整局到 game-over，action log 可纯重放（newGame(同 seed) +
 *    逐条 applyAction 逐字节回到同一终局）；
 * 2. DecisionTrace 字段完整且步数与 log 等长；FixtureClient 恒选候选 0
 *    （prescreen TopK 之首 = 启发式最优）→ chosenRank 恒 0；
 * 3. gameRecord/TraceWriter：VP/胜者/usage/degraded 汇总与 JSONL 落盘格式。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAction,
  newGame,
  stableStringify,
  type Action,
} from '@brass/engine';
import { LLMAgent } from '../src/llm-agent.js';
import { driveGame } from '../bench/drive-game.js';
import { TraceWriter, gameRecord } from '../bench/trace.js';
import { FixtureClient } from './fixtures.js';

const SEED = 7;

/** FixtureClient 恒返回 choiceIndex=0（候选首位），LLMAgent 走正常路径。 */
function fixtureAgent() {
  return new LLMAgent(new FixtureClient(), 'normal');
}

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('driveGame', () => {
  it('驱动 2p 整局到 game-over，log 可纯重放到同一终局', async () => {
    const game = await driveGame(2, SEED, [fixtureAgent(), fixtureAgent()]);

    expect(game.state.phase).toBe('game-over');
    expect(game.log.length).toBeGreaterThan(0);
    expect(game.decisions.length).toBe(game.log.length);

    let replay = newGame(2, SEED);
    for (const action of game.log) replay = applyAction(replay, action as Action);
    expect(stableStringify(replay)).toBe(stableStringify(game.state));
  });

  it('DecisionTrace 字段完整；fixture 恒选候选 0 → chosenRank 恒 0、degraded 恒 false', async () => {
    const game = await driveGame(2, SEED, [fixtureAgent(), fixtureAgent()]);
    for (const [i, d] of game.decisions.entries()) {
      expect(d.seq).toBe(i);
      expect([0, 1]).toContain(d.seat);
      expect(['canal', 'rail']).toContain(d.era);
      expect(d.round).toBeGreaterThanOrEqual(1);
      expect(d.legalCount).toBeGreaterThan(0);
      expect(d.chosenRank).toBe(0);
      expect(d.chosen.length).toBeGreaterThan(0);
      expect(d.heuristicTop.length).toBeGreaterThan(0);
      expect(d.degraded).toBe(false);
      expect(d.usage.input).toBeGreaterThan(0);
    }
  });

  it('agents 数不等于 playerCount 抛错', async () => {
    await expect(driveGame(2, SEED, [fixtureAgent()])).rejects.toThrow(
      /need 2 agents, got 1/,
    );
  });
});

describe('gameRecord / TraceWriter', () => {
  it('VP/胜者/usage/degraded 汇总正确，JSONL 落盘逐行可读', async () => {
    const game = await driveGame(2, SEED, [fixtureAgent(), fixtureAgent()]);
    const labels = ['llm:normal', 'llm:normal'];
    const record = gameRecord(game, labels, false, 1234);

    expect(record.seed).toBe(SEED);
    expect(record.mirrored).toBe(false);
    expect(record.vps).toEqual(game.state.players.map((p) => p.vp));
    const best = Math.max(...record.vps);
    const winners = record.vps.flatMap((vp, i) => (vp === best ? [i] : []));
    expect(record.winner).toBe(winners.length === 1 ? winners[0]! : null);
    expect(record.steps).toBe(game.decisions.length);
    expect(record.degraded).toEqual([0, 0]);
    const totalInput = game.decisions.reduce((s, d) => s + d.usage.input, 0);
    expect(record.usage[0]!.input + record.usage[1]!.input).toBe(totalInput);
    expect(record.durationMs).toBe(1234);

    dir = mkdtempSync(join(tmpdir(), 'brass-bench-'));
    const writer = new TraceWriter(dir);
    for (const d of game.decisions) {
      writer.decision({ ...d, seed: SEED, mirrored: false });
    }
    writer.game(record);

    const decisionLines = readFileSync(join(dir, 'decisions.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(decisionLines.length).toBe(game.decisions.length);
    const first = JSON.parse(decisionLines[0]!) as Record<string, unknown>;
    expect(first['seed']).toBe(SEED);
    expect(first['chosenRank']).toBe(0);

    const gameLines = readFileSync(join(dir, 'games.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(gameLines.length).toBe(1);
    expect(JSON.parse(gameLines[0]!)).toEqual(record);
  });
});
