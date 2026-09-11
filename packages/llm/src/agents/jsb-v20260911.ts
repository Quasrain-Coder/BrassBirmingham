/**
 * jsb-v20260911：探索向估价修正版——基于 jsb-v20260908。
 *
 * 方向（2026-09-11，真人 vs 0907/0908 回放深挖的三项估价修正）：
 * - link 未翻建筑图标系数（network.unflippedIconCoefficient=0.6）：Link
 *   端点的未翻面板块按系数计入未来价值——高价值未翻板块（棉/制造/陶）
 *   大概率会翻,其图标在时代末会兑现,高手局该系数 >0.5。
 * - 末轮研发收益归零（develop.endgameZeroRound=1.5）：解锁出的板块在末轮
 *   卖不掉,白解锁——收益只剩铁的成本（回放 seq117:末轮研发解锁 L5 无人
 *   可卖的无效动）。
 * - 酒厂 flip 地板 0.6（flip.breweryRailFlipFloor）：0910 的 0.85 经对照
 *   实验证明会盖过更好的 link 决策（seq104 盖过 [27]）,降至 0.6 恢复。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260911',
    version: '1.0.0',
    description: '探索向估价修正版（0908 + link 未翻建筑系数 + 末轮研发归零 + 酒厂地板 0.6）',
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
    sell: {
      ownBreweryFlipCredit: 1.0,
      opponentBreweryFlipPenalty: 1.0,
    },
    network: {
      unflippedIconCoefficient: 0.6,
    },
    develop: {
      endgameZeroRound: 1.5,
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
  tuneEnvVar: 'BRASS_TUNE11',
});
