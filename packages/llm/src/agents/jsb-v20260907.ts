/**
 * jsb-v20260907：IS-MCTS 版——基于 jsb-v20260903 接入信息集蒙特卡洛树搜索。
 *
 * 方向（2026-09-07，用户指定）：2-ply 前两名价值接近（< gateMargin）的难决策，
 * 交给 IS-MCTS 采样裁决——每次模拟：信息集确定化（重采对手手牌+牌库）→
 * UCB1 选根动作 → 引导推演（1-ply 启发式 + ε-随机）rolloutPlies 步 →
 * evaluatePosition 叶估值，多次采样取均值最优。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260907',
    version: '1.0.0',
    description: 'IS-MCTS 版（0903 + 难决策信息集采样：确定化/引导推演/叶估值）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0 },
    ismcts: { simulations: 40, topK: 4, c: 1.0, valueScale: 200, rolloutPlies: 24, policyEpsilon: 0.1, gateMargin: 3.0 },
  },
  tuneEnvVar: 'BRASS_TUNE7',
});
