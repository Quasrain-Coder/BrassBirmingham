/**
 * zjk-v20261019-loanrelief：默认 + 低值替代贷款救济（E32）。
 *
 * 用户 meta 指令（2026-10-19）："钱多造酒和产业牌，不要惧怕贷款，没钱就贷。
 * 特别是发现需要修低分路/造煤时"——当最优非贷款动作只剩低值选项（<3VP 路/
 * 造煤）时，贷款分 += (reliefFloor − 最优替代分) × reliefScale。
 * reliefFloor=3.0 / reliefScale=1.0。B站 0贷流教学的反向印证：贷款是节奏
 * 工具，低值动作才是真浪费。
 */
import { createHeuristicPlugin } from './heuristic-core.js';
export default createHeuristicPlugin({
  meta: { name: 'zjk-v20261019-loanrelief', version: '1.0.0', description: '默认 + 低值替代贷款救济（E32）', author: 'brass-birmingham' },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0, canalCoalFlipDiscount: 0.7, breweryRailFlipFloor: 0.85, breweryRailFlipDecayWindow: 8, breweryRailFlipLateFloor: 0.6 },
    sell: { ownBreweryFlipCredit: 1.0, opponentBreweryFlipPenalty: 1.0 },
    network: { unflippedIconCoefficient: 0.786 },
    build: { railBrewerySellSupportBonus: 1.557 },
    develop: { endgameZeroRound: 1.5 },
    value: { moneyEndgameRound: 3 },
    loan: { reliefFloor: 3.0, reliefScale: 1.0 },
    ismcts: { simulations: 40, topK: 4, c: 1.0, valueScale: 200, rolloutPlies: 24, policyEpsilon: 0.1, gateMargin: 3.0, allocator: 'paired' },
  },
});
