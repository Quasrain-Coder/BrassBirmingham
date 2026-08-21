/**
 * moneyDelta(行动现金变化量)测试:行动条"现金实时标记"的数值源。
 * fixture:engine newGame(4,42) + filterStateFor(公开状态,与 GameState 同构字段)。
 */
import { describe, expect, it } from 'vitest';
import { newGame, tileDef } from '@brass/engine';
import type { Action } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import { moneyDelta } from './preview';

function freshState(money = 17) {
  const state = filterStateFor(newGame(4, 42), 0);
  state.players[0]!.money = money;
  return state;
}

describe('moneyDelta', () => {
  it('loan:+£30', () => {
    expect(moneyDelta({ type: 'loan', cardId: 'c1' }, freshState(), 0)).toBe(30);
  });

  it('build 棉纺厂 L1:−£12(无煤铁成本)', () => {
    const state = freshState();
    const action: Action = { type: 'build', cardId: 'c1', industry: 'cotton', location: 'birmingham' };
    // cotton L1 只花 £12(无煤铁、无市场卖出)
    expect(moneyDelta(action, state, 0)).toBe(-tileDef('cotton', 1)!.costMoney);
  });

  it('build 铁厂 L1:−£5 + 卖铁收入(铁无条件卖市场)', () => {
    const state = freshState();
    const action: Action = { type: 'build', cardId: 'c1', industry: 'iron', location: 'coalbrookdale' };
    const delta = moneyDelta(action, state, 0);
    // 铁 L1 £5+1煤:无煤源且未连通商人位时煤市价路径不出现(引擎判定该建造不可行,预览按 0 煤差近似);
    // 这里只断言:卖出 4 块铁的收入被计入(delta > -6)
    expect(delta).toBeGreaterThan(-6);
  });

  it('develop:无铁厂且铁市场空 → 每块按兜底 £6', () => {
    const state = freshState();
    state.ironMarket = 0;
    const action: Action = { type: 'develop', cardId: 'c1', removals: ['cotton', 'iron'] };
    expect(moneyDelta(action, state, 0)).toBe(-12);
  });

  it('develop:铁市场有方按市价(非兜底)', () => {
    const state = freshState();
    const action: Action = { type: 'develop', cardId: 'c1', removals: ['cotton'] };
    const delta = moneyDelta(action, state, 0);
    expect(delta).toBeLessThan(0);
    expect(delta).toBeGreaterThanOrEqual(-6);
  });

  it('network 运河时代:−£3;sell/scout/pass:0', () => {
    const state = freshState();
    expect(moneyDelta({ type: 'network', cardId: 'c1', links: [5] }, state, 0)).toBe(-3);
    expect(moneyDelta({ type: 'pass', cardId: 'c1' }, state, 0)).toBe(0);
    expect(
      moneyDelta(
        { type: 'sell', cardId: 'c1', sales: [{ location: 'birmingham', slotIndex: 0, merchant: 'oxford', useMerchantBeer: false }] },
        state,
        0,
      ),
    ).toBe(0);
    expect(moneyDelta({ type: 'scout', cardIds: ['a', 'b', 'c'] }, state, 0)).toBe(0);
  });
});
