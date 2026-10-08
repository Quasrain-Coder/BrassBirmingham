/**
 * jsb-v20261008：MCTS 根候选扩展版——基于 jsb-v20260911。
 *
 * 方向（2026-10-08，快筛唯一一度正向的杠杆）：ismcts.topK 4→8——
 * 根节点送入 IS-MCTS 的候选从 2-ply 价值前 4 名扩到前 8 名。
 *
 * 终验结论（2026-10-09，**未达标，不进 PR**）：
 * - 内战均分 +1.5@30 开局，n=60 复核缩到 +0.3（对照 122.7 vs 123.0，
 *   种子段运气蒸发）；
 * - head2head vs 0911（PAIRED 精确对消座位）n=174+ 胜率 ~43.7%，
 *   稳定为负；剂量响应甜点形（topK12 -4.1@10）；
 * - 同期 17 个评估面探针（压煤/长线建造/路值/走廊/卖紧迫/批量卖/
 *   垃圾路压制/深 MCTS/流派/叶权重/四动权重/各组合）全部落在 ±1
 *   噪声带或为负——0911 的 MCTS 未来估值会吸收根评估扰动，
 *   配置层面已是平坦高原，本文件仅作实验记录保留。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20261008',
    version: '1.0.0',
    description: 'MCTS 根候选扩展版（0911 + topK 4→8）',
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
      topK: 8,
      c: 1.0,
      valueScale: 200,
      rolloutPlies: 24,
      policyEpsilon: 0.1,
      gateMargin: 3.0,
      allocator: 'paired',
    },
  },
  tuneEnvVar: 'BRASS_TUNE1008',
});
