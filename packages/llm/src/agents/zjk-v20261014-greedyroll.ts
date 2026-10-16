/**
 * zjk-v20261014-greedyroll：0906-rollout + 引导推演（rolloutGreedySelf=2）。
 *
 * E23（结构性候选，信号侧修复）：推演中决策者自己的前 2 步改用 scoreLegal
 * 贪心 argmax（对手仍随机）。动机：随机自走把自己后续 tempo 在两个候选分支
 * 里同等程度地埋掉——候选间真实差异被系统性稀释（与 E19 CRN 的方差侧
 * 修复正交）。贪心分支不消费随机流，旧路径（N=0）rand 序列字节不变。
 *
 * 其余与 jsb-v20260906-rollout 完全一致（K8/topK2/delta2.0/margin3.0，
 * 独立随机流——E19 已证 CRN 无收益）。
 * 单变量归因：E23 = 本插件 vs 0903 ×20（bench/docs/TUNING-ITERATION.md 队列）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'zjk-v20261014-greedyroll',
    version: '2.0.0',
    description: '0906-rollout + rolloutGreedySelf=2（引导推演，E23）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5, rolloutK: 8, rolloutDeltaThreshold: 2.0, rolloutGreedySelf: 2 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0 },
  },
  tuneEnvVar: 'BRASS_TUNE11',
});
