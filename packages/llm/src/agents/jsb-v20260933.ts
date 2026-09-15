/**
 * jsb-v20260933：棉花流战略评估版——基于 jsb-v20260914。
 *
 * 方向（2026-09-15，棉花流战略评估）：
 * - 真人回放（brass-YATANA）：胜利方玩独家棉，后期优势大。棉花需要两动
 *   研发，全局评估很难认为这是好的一步，但三因素全部具备时理应走棉花流。
 * - 三因素：独家棉（无对手研发棉花，只打一张 L1 不算）+ 贸易商奖励
 *   （shrewsbury/nottingham 有棉花板块）+ 手牌储备（棉花产业/城市牌）。
 * - cottonStrategy：独家棉建造 +3 / 贸易商奖励建造 +2 / 手牌储备建造 +1/张 /
 *   三因素全具备研发 +2 / 三因素全具备卖出 +2。
 * - 继承 0914 终局强化（内战 126.8）。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260933',
    version: '1.0.0',
    description: '棉花流战略评估版（0914 + 独家棉/贸易商/手牌三因素）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    build: {
      cottonStrategy: {
        enabled: true,
        exclusiveBonus: 3.0,
        merchantBonus: 2.0,
        handCardBonus: 1.0,
        developBonus: 2.0,
      },
    },
    flip: {
      railSellableNoOwnBeerPenalty: 3.0,
      canalCoalFlipDiscount: 0.7,
      breweryRailFlipFloor: 0.85,
      breweryRailFlipDecayWindow: 8,
      breweryRailFlipLateFloor: 0.6,
    },
    sell: {
      ownBreweryFlipCredit: 1.0,
      opponentBreweryFlipPenalty: 1.0,
      urgencyBonus: 5.0,
      railLateVpScale: 0.5,
    },
    network: {
      unflippedIconCoefficient: 0.6,
    },
    develop: {
      endgameZeroRound: 1.5,
    },
    loan: {
      endgameRoundsThreshold: 1.5,
      endgameLoanPenalty: 5.0,
    },
    ismcts: {
      simulations: 40,
      topK: 4,
      c: 1.0,
      valueScale: 200,
      rolloutPlies: 24,
      policyEpsilon: 0.1,
      gateMargin: 3.0,
      allocator: 'paired',
    },
  },
  tuneEnvVar: 'BRASS_TUNE33',
});
