/**
 * jsb-v20260903：启发式 AI 调优版——基于 jsb-v20260902 继续迭代。
 *
 * 配置定案（2026-09-02，PAIRED 完全配对基准；相对 jsb-v20260901）：
 * - **yo-yo 四连动前瞻**（lookahead.fourActionWeight 0.5）：本轮我是最后
 *   行动者且本回合 spent 最低锁定下轮先手时，追加评估下轮最佳行动的
 *   先手价值——末位少花 → 首位连动 4 次，高手常规武器（顺位规则：
 *   spent 升序稳定重排；探针实测四连动每局自然发生 5-10 次）。
 *   甜区 0.5（0.4/0.7/1.0 均更差）；完整链（下轮两动）不增益。
 * 终验（PAIRED n=200）：vs jsb-0901 **74%**（148/200，VP +8.0/+10.7）；
 * 内战 4p×100 人均 **112.5**（0902：112.0）。
 * 迭代全史见 bench/docs/2026-09-02-jsb0902-optimization.md。
 *
 * 本文件为 heuristic-core 的配置壳——本版 = 0902 定案 + 四连动权重；
 * 核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260903',
    version: '2.0.0',
    description: '启发式评分 AI 调优版（0902 迭代：yo-yo 四连动前瞻，末位保先手连打）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
  },
  tuneEnvVar: 'BRASS_TUNE4',
});
