/**
 * jsb-v20260902a：启发式 AI 调优版——基于 jsb-v20260901 继续迭代
 * （brass-assistant 2026-08-29 重构版移植），叠加本项目自研引导。
 *
 * 配置定案（2026-09-02，PAIRED 完全配对基准；相对 jsb-v20260901）：
 * - **结构升级：局面估值叶**（leaf.weight 0.5，上游 MCTS 叶评估器
 *   evaluate_position 移植）——2-ply 前瞻的叶子从"只看现金惩罚"升级为
 *   完整局面评估（已入账 VP + 版面已翻/未翻 VP 估计[运河 L2+ 双计分口径]
 *   + Link 当前图标 + 现金/收入折算 + 手牌灵活性），等效延展决策视野。
 *   权重甜区 0.5（0.7/1.0/2.0 均更差）。
 * 终验（PAIRED n=100-200/组）：vs jsb-0901 **71.5%**（143/200）；
 * vs lm-0829 **84%**；vs lm-0826 **96%**；内战 4p×100 人均 **112.0**
 * （0901：110.2）。结构选型调研与迭代全史见
 * bench/docs/2026-09-02-jsb0902-optimization.md。
 *
 * 2026-09-02 重构：本文件为 heuristic-core 的配置壳（BASE_CFG 即本版定案，
 * overrides 为空）；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260902a',
    version: '2.0.0',
    description: '启发式评分 AI 调优版（0901 迭代：MCTS 局面估值叶移植，2-ply 视野延展）',
    author: 'brass-birmingham',
  },
  overrides: {},
  tuneEnvVar: 'BRASS_TUNE3',
});
