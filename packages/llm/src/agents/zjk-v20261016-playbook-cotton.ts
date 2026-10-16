/**
 * zjk-v20261016-playbook-cotton：20261010（现默认）+ 打法选择层 v1（cotton3 线）。
 *
 * E28：开局手牌对棉花的精确支持度（产业卡+槽位匹配位置卡+百搭×0.5）≥3
 * 时判定 cotton3 套路，canal 时代对 cotton/brewery/coal 建造分乘
 * 1.35/1.15/1.1——"套路按需选择"（B 站 meta 23 条），拿棉花手就打棉花。
 *
 * 动机（影子探测，0903 ×12）：cotton3 手牌座位 VP 108.8 vs iron-beer 123.3
 * ——错位 15 VP 纯上行空间；基础为 20261010（E26 对决双高胜出的新默认）。
 * 单变量归因：E28 = 本插件 vs 20261010 ×20（名次积分 v2）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'zjk-v20261016-playbook-cotton',
    version: '1.0.0',
    description: '20261010 + 打法选择层 v1（cotton3 线按需加权，E28）',
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
    playbook: { enabled: 1, cotton3Threshold: 3.0, cottonBoost: 1.35, breweryBoost: 1.15, coalBoost: 1.1 },
  },
  tuneEnvVar: 'BRASS_TUNE12',
});
