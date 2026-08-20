/**
 * 审计域 G：初始设置 —— 弃牌堆底数量与每时代轮数。
 *
 * 规则出处：
 * - 规则书 p.5 玩家区设置（逐步为每名单独玩家执行：1 Take a Player Mat …
 *   8 Draw 8 cards … 9 "Draw 1 additional card from the Draw Deck and place it
 *   face down in your player area; this is your Discard Pile."）→ 每位玩家各 1 张
 *   面朝下弃牌堆底，共 playerCount 张退出运河时代卡牌循环。
 * - 规则书 p.6 "There are exactly 8/9/10 rounds per era in a 4/3/2-players game."
 * - rules-reference §4「手牌 8 张；再抽 1 张面朝下作为弃牌堆底」（逐玩家设置语境）
 *   与 §8 变体表「每时代轮数 10/9/8」。
 *
 * 交叉验证（卡牌守恒）：牌堆 64/54/40 张，运河时代每人行动 2R−1 次（首轮 1 次），
 * 只有"每人 1 张堆底"才能使 N − playerCount = playerCount×(2R−1) 成立：
 *   4p: 64−4=60=4×15 ✓   3p: 54−3=51=3×17 ✓   2p: 40−2=38=2×19 ✓
 * 且铁路时代 N = 2·playerCount·R 同样精确成立（弃牌堆底重洗入铁路牌堆）。
 */
import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { applyAction } from '../src/apply.js';

/** 全程只 Pass 地打完运河时代，返回时代切换后的状态与每人行动数。 */
function playPassOnlyCanalEra(playerCount: 2 | 3 | 4, seed: number) {
  let s = newGame(playerCount, seed);
  const actions = new Array<number>(playerCount).fill(0);
  let guard = 0;
  while (s.era === 'canal') {
    if (++guard > 500) throw new Error('canal era did not end (deadlock?)');
    const p = s.turnOrder[s.currentPlayerIdx]!;
    const card = s.players[p]!.hand[0];
    if (!card) throw new Error(`player ${p} has no card but was not skipped`);
    s = applyAction(s, { type: 'pass', cardId: card.id });
    actions[p]!++;
  }
  return { after: s as GameState, actions };
}

describe('audit-g: 弃牌堆底（规则书 p.5 步骤 9，逐玩家）', () => {
  it.each([2, 3, 4] as const)('%ip: 每位玩家各 1 张面朝下弃牌堆底', (n) => {
    const s = newGame(n, 3);
    // 期望：弃牌区共 n 张（每人 1 张）。实际引擎实现为全局仅 1 张。
    expect(s.discard).toHaveLength(n);
  });
});

describe('audit-g: 每时代轮数恰好 8/9/10（规则书 p.6）', () => {
  it.each([
    [4, 8, 15], // 4p：8 轮，每人 1 + 2×7 = 15 次行动
    [3, 9, 17], // 3p：9 轮，每人 1 + 2×8 = 17 次行动
    [2, 10, 19], // 2p：10 轮，每人 1 + 2×9 = 19 次行动
  ] as const)(
    '%ip 运河时代恰好 %i 轮结束、每人恰 %i 次行动',
    (n, rounds, actionsEach) => {
      const { after, actions } = playPassOnlyCanalEra(n, 3);
      // 时代在第 rounds 轮结束后切换 → round 计数推进到 rounds+1。
      expect(after.era).toBe('rail');
      expect(after.round).toBe(rounds + 1);
      // 每位玩家行动数相等（无玩家获得额外行动）。
      expect(actions).toEqual(new Array<number>(n).fill(actionsEach));
    },
  );
});
