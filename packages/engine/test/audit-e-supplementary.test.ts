/**
 * 审计域 E 补充合规证据：Develop / Loan / Scout / Pass 逐条核对（只读审计，不修改 src）。
 * 规则依据：规则书 p.11（Develop/Loan/Scout）、p.6（Scout/Pass/Build 唯一需特定卡）、
 * p.8（Consuming Iron）；rules-reference §6.4/6.6/6.7/6.8、§9.8/§9.16。
 */
import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { applyAction, enumerateActions } from '../src/apply.js';
import { applyDevelop, enumerateDevelop } from '../src/actions/develop.js';
import { applyLoan, enumerateLoan } from '../src/actions/loan.js';
import { incomeLevelAt } from '../src/data/income.js';
import type { PlayerIndex } from '../src/types.js';
import type { Card } from '../src/data/cards.js';

/** 当前行动玩家。 */
function currentPlayer(s: GameState): PlayerIndex {
  return s.turnOrder[s.currentPlayerIdx]!;
}

describe('audit-E 补充：Develop', () => {
  it('灯泡陶板块不可 Develop：P1 在面板时 pottery 不可研发；P1 移走后 P2 可单块研发但不可双块（P3 也是灯泡，逐块判定）（规则书 p.11 "Potteries and the Lightbulb Icon"）', () => {
    const s = newGame(4, 3);
    // 初始面板陶栈顶 = pottery I（developable:false）→ pottery 完全不可研发
    const devs0 = enumerateDevelop(s, 0);
    expect(devs0.every((a) => a.type === 'develop' && !a.removals.includes('pottery'))).toBe(true);

    // 模拟 P1 已被 Build 移出面板：栈顶变为 pottery II（可研发）
    const ps = s.players[0]!;
    ps.tiles = ps.tiles.filter((t) => !(t.industry === 'pottery' && t.level === 1));
    const devs1 = enumerateDevelop(s, 0);
    expect(devs1.some((a) => a.type === 'develop' && a.removals.length === 1 && a.removals[0] === 'pottery')).toBe(true);
    // 双块 [pottery, pottery] 不可枚举：移 P2 后新栈顶 P3 是灯泡（逐块判定）
    expect(devs1.some((a) => a.type === 'develop' && a.removals.length === 2 && a.removals[0] === 'pottery' && a.removals[1] === 'pottery')).toBe(false);
  });

  it('同产业双块研发逐块判定：cotton 有 3 块 1 级，[cotton, cotton] 合法且移除两块 1 级棉（规则书 p.11 "must be the lowest level tile of the chosen industry (as it is removed)"）', () => {
    const s = newGame(4, 3);
    const devs = enumerateDevelop(s, 0);
    const two = devs.find(
      (a) => a.type === 'develop' && a.removals.length === 2 && a.removals[0] === 'cotton' && a.removals[1] === 'cotton',
    )!;
    expect(two).toBeDefined();
    const before = s.players[0]!.tiles.filter((t) => t.industry === 'cotton' && t.level === 1);
    expect(before).toHaveLength(3);
    const after = applyDevelop(s, 0, two);
    const remain = after.players[0]!.tiles.filter((t) => t.industry === 'cotton' && t.level === 1);
    expect(remain).toHaveLength(1); // 移除 2 块 1 级棉
    expect(after.players[0]!.tiles).toHaveLength(s.players[0]!.tiles.length - 2); // 板块退出游戏
    expect(after.players[0]!.money).toBe(17 - 4); // 无铁厂，市场买 2 块铁 £2+£2
    expect(after.ironMarket).toBe(6); // 8 - 2
  });

  it('develop 可弃任意卡：手牌每张卡都出现在 develop 枚举中（规则书 p.9 "Unlike other actions... Build requires an appropriate card"）', () => {
    const s = newGame(4, 3);
    const ps = s.players[0]!;
    const devs = enumerateDevelop(s, 0);
    for (const c of ps.hand) {
      expect(devs.some((a) => a.type === 'develop' && a.cardId === c.id)).toBe(true);
    }
  });
});

describe('audit-E 补充：Loan', () => {
  it('贷款 +£30、收入后退 3 个**等级**（不是格）并落在新等级最高格（规则书 p.11 Loan step 2；§9.8）', () => {
    const s = newGame(4, 3);
    const ps = s.players[0]!;
    ps.incomeSpace = 25; // 等级 +8（格 25–26 同属 +8）
    expect(incomeLevelAt(25)).toBe(8);
    const cardId = ps.hand[0]!.id;
    const after = applyLoan(s, 0, { type: 'loan', cardId });
    expect(after.players[0]!.money).toBe(17 + 30);
    // 等级 8 - 3 = 5；等级 5 占格 19–20，落最高格 20（若错按格退则是 22）
    expect(incomeLevelAt(20)).toBe(5);
    expect(after.players[0]!.incomeSpace).toBe(20);
  });

  it('贷款下限：当前等级 −7 可贷（落到 −10 格 0）；当前等级 −8 不可贷（退 3 级将破 −10）（规则书 p.11 "cannot take a loan if it will take your income level below -10"）', () => {
    const s = newGame(4, 3);
    const ps = s.players[0]!;
    ps.incomeSpace = 3; // 等级 −7
    expect(incomeLevelAt(3)).toBe(-7);
    expect(enumerateLoan(s, 0).length).toBeGreaterThan(0);
    const after = applyLoan(s, 0, { type: 'loan', cardId: ps.hand[0]!.id });
    expect(after.players[0]!.incomeSpace).toBe(0); // 等级 −10 唯一格
    expect(incomeLevelAt(after.players[0]!.incomeSpace)).toBe(-10);

    const s2 = newGame(4, 3);
    s2.players[0]!.incomeSpace = 2; // 等级 −8
    expect(incomeLevelAt(2)).toBe(-8);
    expect(enumerateLoan(s2, 0)).toHaveLength(0);
    expect(() => applyLoan(s2, 0, { type: 'loan', cardId: s2.players[0]!.hand[0]!.id })).toThrowError(
      /illegal-loan/,
    );
  });
});

describe('audit-E 补充：Scout', () => {
  it('scout 弃 3 张进弃牌堆、拿 1 Wild Location + 1 Wild Industry、供应堆各减 1（规则书 p.11 Scout steps 1–2）', () => {
    const s = newGame(4, 3);
    const p = currentPlayer(s);
    expect(s.wildSupply).toEqual({ location: 4, industry: 4 });
    const scouts = enumerateActions(s, p).filter((a) => a.type === 'scout');
    expect(scouts).toHaveLength(56); // C(8,3)，弃哪 3 张有策略意义
    const discardBefore = s.discard.length;
    const after = applyAction(s, scouts[0]!);
    const hand = after.players[p]!.hand;
    expect(hand).toHaveLength(8); // 8-3+2 后补牌回 8
    expect(hand.filter((c) => c.kind === 'wild-location')).toHaveLength(1);
    expect(hand.filter((c) => c.kind === 'wild-industry')).toHaveLength(1);
    expect(after.wildSupply).toEqual({ location: 3, industry: 3 });
    expect(after.discard).toHaveLength(discardBefore + 3); // 3 张全进弃牌堆
  });

  it('手中已有 Wild 卡不可 Scout（规则书 p.11 "You may not perform this action if you already have a Wild card in your Hand"）', () => {
    const s = newGame(4, 3);
    const p = currentPlayer(s);
    const wild: Card = { id: 'wild-location-0', kind: 'wild-location' };
    s.players[p]!.hand = [wild, ...s.players[p]!.hand.slice(0, 7)];
    s.wildSupply = { location: 3, industry: 4 };
    expect(enumerateActions(s, p).some((a) => a.type === 'scout')).toBe(false);
  });

  it('任一 Wild 供应堆为空时不可 Scout（组件限制：无法同时拿两种 Wild 卡）', () => {
    const s = newGame(4, 3);
    const p = currentPlayer(s);
    s.wildSupply = { location: 0, industry: 4 };
    expect(enumerateActions(s, p).some((a) => a.type === 'scout')).toBe(false);
    s.wildSupply = { location: 4, industry: 0 };
    expect(enumerateActions(s, p).some((a) => a.type === 'scout')).toBe(false);
  });
});

describe('audit-E 补充：Pass', () => {
  it('pass 代替行动仍须弃 1 张卡（进弃牌堆），其余状态不变（规则书 p.6 "must still discard a card for each action you pass"）', () => {
    const s = newGame(4, 3);
    const p = currentPlayer(s);
    const ps = s.players[p]!;
    const passes = enumerateActions(s, p).filter((a) => a.type === 'pass');
    expect(passes).toHaveLength(ps.hand.length); // 每张手牌都可用于 pass
    const target = ps.hand[0]!;
    const discardBefore = s.discard.length;
    const after = applyAction(s, { type: 'pass', cardId: target.id });
    expect(after.discard).toHaveLength(discardBefore + 1);
    expect(after.discard.at(-1)!.id).toBe(target.id);
    expect(after.players[p]!.hand).toHaveLength(8); // 弃 1 补 1
    expect(after.players[p]!.money).toBe(ps.money);
    expect(after.players[p]!.incomeSpace).toBe(ps.incomeSpace);
    expect(after.players[p]!.vp).toBe(ps.vp);
    expect(after.players[p]!.spentThisRound).toBe(0);
  });
});
