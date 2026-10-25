/**
 * jsb-v20261022-e34-sims80：E34 搜索层探针（冠军 + simulations 40→80）——基于 jsb-v20260911。
 *
 * 方向（2026-10-09，参数搜索 24 配置×12 局 + 30 局复核唯一确认的热区）：
 * build.railBrewerySellSupportBonus 1.557 + network.unflippedIconCoefficient
 * 0.786——铁路时代酿酒厂对卖货的支撑价值上调 + Link 端点未翻板块按
 * 0.786 计入未来价值。
 *
 * 验证（2026-10-10，全部同种子配对）：内战均分 +1.9@30（对照 122.0，
 * 两次独立复核 123.9/123.9）、+1.4@60（对照 122.7，胜者均 138.3 vs
 * 135.9）；head2head vs 0911（PAIRED 对消座位）n≈300 胜率 ~52%。
 * 背景：17+ 评估面探针与 topK8（h2h 43.2% n=185）均已否决，
 * 本配置是参数搜索在平坦高原上找到的第一个可复现热区。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'zjk-v20261022-e34-sims80',
    version: '1.0.0',
    description: 'E34：冠军 + ISMCTS simulations 40→80（估值层七连否后的搜索层方向）',
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
      unflippedIconCoefficient: 0.786,
    },
    build: {
      railBrewerySellSupportBonus: 1.557,
    },
    develop: {
      endgameZeroRound: 1.5,
    },
    // E29a（2026-10-17）：终局金钱燃烧——铁路末 3 轮 moneyW 线性衰减到 0。
    // ×20 +1.80/局 人均 +7.2 强双高；×120 +0.333/局 人均 +1.0 双高合入。
    // 审计动机：冠军线人均终局余钱 £51.5 纯漏斗。×500 跨带终验中。
    value: { moneyEndgameRound: 3 },
    ismcts: {
      simulations: 80,
      topK: 4,
      c: 1.0,
      valueScale: 200,
      rolloutPlies: 24,
      policyEpsilon: 0.1,
      gateMargin: 3.0,
      allocator: 'paired',
    },
  },
  tuneEnvVar: 'BRASS_TUNE1034',
});
