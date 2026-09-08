/**
 * jsb-v20260908：IS-MCTS 精调版——基于 jsb-v20260907。
 *
 * 方向（2026-09-08）：
 * - 性能：引擎 assumeLegal 快路径（applyAction 跳过"全量重枚举+逐动作序列化"
 *   的重复校验，推演/2-ply 等已知合法的调用点接入），单局 ~180s → ~45s。
 * - 精细度：ismcts.allocator='paired'（共用随机数配对采样——所有根候选在同一批
 *   确定化世界+同一条推演随机流里对战，z 检验逐轮淘汰劣势候选，两两比较方差
 *   大幅缩减，同等模拟预算下区分度更高）。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260908',
    version: '1.0.0',
    description: 'IS-MCTS 精调版（0907 + assumeLegal 快路径 + paired 配对采样）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0 },
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
  tuneEnvVar: 'BRASS_TUNE8',
});
