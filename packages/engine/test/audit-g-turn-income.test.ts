/**
 * 审计域 G：回合结构与收入结算 —— 补牌时机、铁路时代长度、负收入变现边界、初始设置。
 *
 * 规则出处（规则书 Roxley 2018.11.20）：
 * - p.6 PLAYER TURNS："After all of your actions have been completed, refill your Hand
 *   back up to 8 cards with cards from the Draw Deck."（补牌发生在**全部行动完成后**，
 *   2 行动回合的第 2 个行动只能用 7 张手牌；Scout 后同理为 5+2wild=7 张。）
 * - p.6 ROUNDS："There are exactly 8/9/10 rounds per era in a 4/3/2-players game."
 *   "During the first round of the Canal Era, each player performs only 1 action."
 *   （铁路时代第 1 轮正常 2 行动。）
 * - p.6 Take Income 短绌处理：半价（向下取整）拆**产业板块**（不是 Link）、够付即停、
 *   多余归己、仍不足每缺 £1 扣 1 VP。成本 £0 的板块（Pottery II/IV）变现 £0，不能减少亏空。
 * - p.5 PLAYER AREA SETUP：£17、收入标记格 10（等级 0）、VP 0、手牌 8 张。
 */
import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { applyAction } from '../src/apply.js';
import { endTurnIfNeeded } from '../src/turn.js';
import { INCOME_LEVEL_SPACES } from '../src/data/income.js';
import { LOCATIONS } from '../src/data/board.js';
import { tileDef } from '../src/data/tiles.js';
import { BREWERY_BARRELS } from '../src/data/market.js';
import type { IndustryType, LocationId, PlayerIndex } from '../src/types.js';

/** 与 turn.test.ts 相同的辅助：直接放一块板到该产业首个匹配空槽。 */
function withTile(
  state: GameState,
  player: PlayerIndex,
  location: LocationId,
  industry: IndustryType,
  level = 1,
): void {
  const def = tileDef(industry, level);
  if (!def) throw new Error('missing tile def');
  const slotDefs = LOCATIONS[location]!.slots;
  const slots = state.board.slots[location]!;
  const idx = slotDefs.findIndex((sd, i) => sd.industries.includes(industry) && slots[i] === null);
  if (idx < 0) throw new Error(`no empty slot for ${industry} at ${location}`);
  slots[idx] = {
    tile: def,
    player,
    flipped: false,
    resources: industry === 'brewery' ? BREWERY_BARRELS[state.era] : def.resourcesPlaced,
  };
}

describe('audit-g: 补牌时机（规则书 p.6 "After all of your actions have been completed"）', () => {
  it('2 行动回合的第 1 个行动后不应立即补牌：手牌 7 张、牌堆顶牌尚未入手', () => {
    const s = newGame(4, 3);
    s.round = 2; // 普通轮，每人 2 行动
    const p = s.turnOrder[0]!;
    const deckTop = s.deck[0]!.id;
    const deckBefore = s.deck.length;

    const after = applyAction(s, { type: 'pass', cardId: s.players[p]!.hand[0]!.id });

    // 该玩家还剩 1 个行动，回合未结束
    expect(after.currentPlayerIdx).toBe(0);
    expect(after.actionsThisTurn).toBe(1);
    // 规则期望：补牌在全部行动完成后 → 此时手牌 7 张、牌堆未动、牌堆顶牌不在手中。
    // 引擎实际：每个行动后立即补回 8 张（apply.ts refillHand），第 2 个行动可打出
    // 本不该到手的牌（如刚抽到的地点卡立刻用于 Build），行动枚举面被扩大。
    expect(after.players[p]!.hand).toHaveLength(7);
    expect(after.deck).toHaveLength(deckBefore);
    expect(after.players[p]!.hand.some((c) => c.id === deckTop)).toBe(false);
  });

  it('回合全部行动完成后补回 8 张（端态合规）', () => {
    const s = newGame(4, 3);
    s.round = 2;
    const p = s.turnOrder[0]!;
    const mid = applyAction(s, { type: 'pass', cardId: s.players[p]!.hand[0]!.id });
    const after = applyAction(mid, { type: 'pass', cardId: mid.players[p]!.hand[0]!.id });
    expect(after.currentPlayerIdx).toBe(1); // 回合结束换人
    expect(after.players[p]!.hand).toHaveLength(8); // 补回 8 张 ✓
  });
});

describe('audit-g: 全程 Pass 打完整局（铁路时代长度 + 铁路第 1 轮 2 行动）', () => {
  /** 全程 Pass 打到 game-over，按时代分别统计每人行动数。 */
  function playPassOnlyGame(playerCount: 2 | 3 | 4, seed: number) {
    let s = newGame(playerCount, seed);
    const canal = new Array<number>(playerCount).fill(0);
    const rail = new Array<number>(playerCount).fill(0);
    let guard = 0;
    while (s.phase !== 'game-over') {
      if (++guard > 2000) throw new Error('game did not end (deadlock?)');
      const p = s.turnOrder[s.currentPlayerIdx]!;
      const card = s.players[p]!.hand[0];
      if (!card) throw new Error(`player ${p} has no card but was not skipped`);
      const era = s.era;
      s = applyAction(s, { type: 'pass', cardId: card.id });
      (era === 'canal' ? canal : rail)[p]!++;
    }
    return { after: s as GameState, canal, rail };
  }

  it.each([
    [4, 16], // 铁路 8 轮 × 2 行动
    [3, 18], // 铁路 9 轮 × 2 行动
    [2, 20], // 铁路 10 轮 × 2 行动
  ] as const)(
    '%ip: 到达终局，铁路时代每人恰 %i 次行动（含铁路第 1 轮 2 行动）',
    (n, railActionsEach) => {
      const { after, rail } = playPassOnlyGame(n, 3);
      expect(after.phase).toBe('game-over');
      expect(after.winner).not.toBeNull();
      // 运河末重洗全部弃牌（含堆底）→ 铁路时代牌堆完整；若铁路第 1 轮被错设为
      // 1 行动，抽牌/手牌消耗错位，每人行动数不可能恰好 2×轮数。
      expect(rail).toEqual(new Array<number>(n).fill(railActionsEach));
    },
  );
});

describe('audit-g: 负收入变现边界（规则书 p.6 Take Income）', () => {
  it('成本 £0 的板块（Pottery II）不可变现减少亏空；Link 不拆；余缺扣 VP', () => {
    const s = newGame(4, 3);
    s.round = 2;
    s.actionsThisTurn = 2;
    s.currentPlayerIdx = 3; // 一轮最后一步
    s.players[0]!.incomeSpace = INCOME_LEVEL_SPACES(-3)[0]; // 等级 −3，欠 £3
    s.players[0]!.money = 1;
    withTile(s, 0, 'belper', 'pottery', 2); // 成本 £0 → 半价 £0，拆了也减不了亏空
    s.board.links = [{ linkIndex: 0, player: 0, era: 'canal' }]; // Link 永远不能变现

    const after = endTurnIfNeeded(s);
    // 现金 £1 全付，缺 £2 → 扣 2 VP
    expect(after.players[0]!.money).toBe(0);
    expect(after.players[0]!.vp).toBe(-2);
    // £0 板块与 Link 均保留在场上
    expect(after.board.slots['belper']!.some((t) => t !== null)).toBe(true);
    expect(after.board.links).toHaveLength(1);
  });
});

describe('audit-g: 初始设置（规则书 p.5 PLAYER AREA SETUP）', () => {
  it.each([2, 3, 4] as const)('%ip: £17、收入格 10（等级 0）、VP 0、手牌 8 张', (n) => {
    const s = newGame(n, 3);
    for (const p of s.players) {
      expect(p.money).toBe(17);
      expect(p.incomeSpace).toBe(10);
      expect(p.vp).toBe(0);
      expect(p.hand).toHaveLength(8);
    }
    expect(s.era).toBe('canal');
    expect(s.round).toBe(1);
  });
});
