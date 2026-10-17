/**
 * zjk-v20261017-burn3：20261010 + 终局金钱燃烧（E29）。
 *
 * 动机：20261010 冠军线审计人均终局余钱 £51.5——终局现金零价值，是纯漏斗。
 * 机制：value.moneyEndgameRound=3——铁路时代剩余 ≤3 轮时 moneyW 线性衰减到 0
 * （运河时代不衰减，余钱带入铁路）。花钱动作的有效成本随衰减下降，
 * 末轮"花钱买 VP"相对"囤钱"自动占优。
 * 对照实验：本插件 vs jsb-v20261010 ×20（名次积分 v2，单变量）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'zjk-v20261017-burn3',
    version: '1.0.0',
    description: '20261010 + 终局金钱燃烧 moneyEndgameRound=3（E29）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: {
      railSellableNoOwnBeerPenalty: 2.0,
      canalCoalFlipDiscount: 0.7,
      breweryRailFlipFloor: 0.85,
      breweryRailFlipDecayWindow: 8,
      breweryRailFlipLateFloor: 0.6,
    },
    sell: { ownBreweryFlipCredit: 1.0, opponentBreweryFlipPenalty: 1.0 },
    network: { unflippedIconCoefficient: 0.786 },
    build: { railBrewerySellSupportBonus: 1.557 },
    develop: { endgameZeroRound: 1.5 },
    value: { moneyEndgameRound: 3 },
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
});
