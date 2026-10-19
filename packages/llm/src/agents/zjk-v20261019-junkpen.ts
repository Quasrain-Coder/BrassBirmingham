/**
 * zjk-v20261019-junkpen：默认 + 垃圾路压制（E30a）。
 * 依据：railmix ×80 审计——铁路 9.05 条/人中 2.19 条 <3VP（24%），
 * 路均 3.3VP vs meta ~6VP。lowValueFloor=3/Penalty=1.0（现成旋钮，默认关）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';
export default createHeuristicPlugin({
  meta: { name: 'zjk-v20261019-junkpen', version: '1.0.0', description: '默认 + 垃圾路压制（E30a）', author: 'brass-birmingham' },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0, canalCoalFlipDiscount: 0.7, breweryRailFlipFloor: 0.85, breweryRailFlipDecayWindow: 8, breweryRailFlipLateFloor: 0.6 },
    sell: { ownBreweryFlipCredit: 1.0, opponentBreweryFlipPenalty: 1.0 },
    network: { unflippedIconCoefficient: 0.786, lowValueFloor: 3.0, lowValuePenalty: 1.0 },
    build: { railBrewerySellSupportBonus: 1.557 },
    develop: { endgameZeroRound: 1.5 },
    value: { moneyEndgameRound: 3 },
    ismcts: { simulations: 40, topK: 4, c: 1.0, valueScale: 200, rolloutPlies: 24, policyEpsilon: 0.1, gateMargin: 3.0, allocator: 'paired' },
  },
});
