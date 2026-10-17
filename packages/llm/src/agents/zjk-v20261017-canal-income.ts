/**
 * zjk-v20261017-canal-income：20261010 + 运河时代收入权重上调（E29b）。
 *
 * 动机（B站教学引，几百把实证）："一时代收入≈分数"——1 收入 ≈ 1 VP。
 * 现行 canal incomeW = 0.25×(1.8+0.6·eraFrac) ≈ 0.45~0.6，远低于 meta 的 1.0。
 * 本变体 canal incomeAdd 1.8→3.4（incomeW ≈ 0.85~1.0），rail 不动（已趋 0）。
 * 注意：0903 时代全局 income 上调 ×20 双不高被否决过——本次是 era 分段
 * 定向调（railLate income 本已为 0），且基线换成了 20261010，重新验证。
 * 对照实验：本插件 vs jsb-v20261010 ×20（名次积分 v2，单变量）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'zjk-v20261017-canal-income',
    version: '1.0.0',
    description: '20261010 + 运河收入权重 incomeAdd 3.4（一时代收入≈分数，E29b）',
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
    era: {
      canalEarly: { incomeAdd: 3.4 },
      canalLate: { incomeAdd: 3.4 },
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
});
