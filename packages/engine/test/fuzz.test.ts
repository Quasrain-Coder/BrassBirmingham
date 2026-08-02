/**
 * Fuzz 对局（M1 验收门）：RandomAgent 驱动随机整局，断言全部正常终止且终态
 * 满足全局不变量。applyAction 的合法性校验（重枚举比对）全程开启——任何引擎
 * 内部产生的非法转移都会在此抛 IllegalActionError。
 *
 * 不变量：钱非负；收入轨下标在 [0, 99]；VP 为有限数（负收入现金/板块不足时
 * 按 £1=1VP 扣减，可为负，见 turn.ts payNegativeIncome）。
 */
import { describe, expect, it } from 'vitest';
import { playGame } from '../src/agents/random.js';
import type { GameState } from '../src/state.js';
import type { Action } from '../src/types.js';

/**
 * 每局行动数下限（sanity floor，防退化提前终局）：总行动数 ≈ 两时代各循环一遍
 * 牌池 + scout 引入的 wild 卡。2p 牌池 31 张/时代（实测 ~79 步）、3p 45（~107
 * 步）、4p 更多——`log > 100` 仅对 4p 成立，低人数按牌池规模放宽。
 */
const MIN_LOG_LENGTH: Record<2 | 3 | 4, number> = { 2: 40, 3: 60, 4: 100 };

function expectSaneFinal(state: GameState, log: Action[]): void {
  expect(state.phase).toBe('game-over');
  expect(state.winner).not.toBeNull();
  expect(state.winner!.length).toBeGreaterThan(0);
  for (const w of state.winner!) {
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThan(state.playerCount);
  }
  expect(log.length).toBeGreaterThan(MIN_LOG_LENGTH[state.playerCount]);
  for (const p of state.players) {
    expect(p.money).toBeGreaterThanOrEqual(0);
    expect(p.incomeSpace).toBeGreaterThanOrEqual(0);
    expect(p.incomeSpace).toBeLessThanOrEqual(99);
    expect(Number.isFinite(p.vp)).toBe(true);
  }
}

describe('fuzz', () => {
  it('300 random 4p games all terminate with sane final state', { timeout: 300_000 }, () => {
    for (let seed = 0; seed < 300; seed++) {
      const { state, log } = playGame(4, seed);
      expectSaneFinal(state, log);
    }
  });

  it('fuzz 2p and 3p (100 games each)', { timeout: 180_000 }, () => {
    for (let seed = 0; seed < 100; seed++) {
      const g2 = playGame(2, seed);
      expectSaneFinal(g2.state, g2.log);
      const g3 = playGame(3, seed);
      expectSaneFinal(g3.state, g3.log);
    }
  });

  it('same seed reproduces the identical game (deterministic)', () => {
    const a = playGame(4, 42);
    const b = playGame(4, 42);
    expect(a.log).toEqual(b.log);
    expect(a.state).toEqual(b.state);
  });
});
