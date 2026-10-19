/**
 * zjk-v20261019-iconprem：默认 + 端点图标溢价（E30b）。
 * unflippedIconCoefficient 0.786→1.1：把铁路往已开发高图标端点引导，
 * 提高路均 VP（3.3 → meta ~6 的方向）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';
export default createHeuristicPlugin({
  meta: { name: 'zjk-v20261019-iconprem', version: '1.0.0', description: '默认 + 端点图标溢价 1.1（E30b）', author: 'brass-birmingham' },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0, canalCoalFlipDiscount: 0.7, breweryRailFlipFloor: 0.85, breweryRailFlipDecayWindow: 8, breweryRailFlipLateFloor: 0.6 },
    sell: { ownBreweryFlipCredit: 1.0, opponentBreweryFlipPenalty: 1.0 },
    network: { unflippedIconCoefficient: 1.1 },
    build: { railBrewerySellSupportBonus: 1.557 },
    develop: { endgameZeroRound: 1.5 },
    value: { moneyEndgameRound: 3 },
    ismcts: { simulations: 40, topK: 4, c: 1.0, valueScale: 200, rolloutPlies: 24, policyEpsilon: 0.1, gateMargin: 3.0, allocator: 'paired' },
  },
});
