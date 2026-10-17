/**
 * zjk-v20261010-noburn：E29a 合入前的 20261010 配置冻结留档。
 * 仅用于 ×500 跨带终验的对照侧（old default vs new default），不作大厅选项。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'zjk-v20261010-noburn',
    version: '1.0.0',
    description: '20261010 冻结（无 moneyEndgameRound，E29a 终验对照侧）',
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
