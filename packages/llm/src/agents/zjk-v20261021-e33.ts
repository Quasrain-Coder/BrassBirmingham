/**
 * zjk-v20261021-e33：默认 + 死端探索门控（E33 规划层）。
 *
 * 依据：railmix ×80——垃圾路 2.19 条/人（24%）；E30 静态罚分/E32 贷款救济
 * 三连否共同指向：估值层修补无效，需规划层。本变体把"探索溢价"从无条件支付
 * 改为**死端门控**：链接两端（含额外端点）均无当前合法建造目标（ctx.targets
 * 之 location）时，探索溢价归零——修到死城不拿拓荒分。有解锁目标的连接
 * 保留全额探索分（1.6−0.3×已修）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';
export default createHeuristicPlugin({
  meta: { name: 'zjk-v20261021-e33', version: '1.0.0', description: '默认 + 死端探索门控（E33 规划层）', author: 'brass-birmingham' },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0, canalCoalFlipDiscount: 0.7, breweryRailFlipFloor: 0.85, breweryRailFlipDecayWindow: 8, breweryRailFlipLateFloor: 0.6 },
    sell: { ownBreweryFlipCredit: 1.0, opponentBreweryFlipPenalty: 1.0 },
    network: { unflippedIconCoefficient: 0.786, deadendExplorationKeep: 0 },
    build: { railBrewerySellSupportBonus: 1.557 },
    develop: { endgameZeroRound: 1.5 },
    value: { moneyEndgameRound: 3 },
    ismcts: { simulations: 40, topK: 4, c: 1.0, valueScale: 200, rolloutPlies: 24, policyEpsilon: 0.1, gateMargin: 3.0, allocator: 'paired' },
  },
});
