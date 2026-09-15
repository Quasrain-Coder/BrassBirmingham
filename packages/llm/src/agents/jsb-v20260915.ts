/**
 * jsb-v20260915：棉花流线性估价（有上限）版——基于 jsb-v20260914。
 *
 * 方向（2026-09-15，棉花流线性估价有上限 + 0914 终局强化合并）：
 * - 棉花流三因素线性叠加：独家棉 + 贸易商奖励 + 手牌储备。
 * - 线性估价但有上限（cap=5）：每个因素独立加分（丝滑），但总分封顶
 *   （防过度——0915a/b/c 线性无上限全部失败 89.5-120.2）。
 * - 参数：exclusiveBonus=3.0 / merchantBonus=2.0 / handCardBonus=1.0 / cap=5.0。
 * - 继承 0914 终局强化。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260915',
    version: '1.0.0',
    description: '棉花流线性估价（有上限）版（0914 + 棉花流线性叠加，cap=5）',
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
  tuneEnvVar: 'BRASS_TUNE15',
});
