/**
 * zjk-v20261013-maxn：0903 + 对手回应（MaxN）扣减。
 *
 * opponentResponseWeight（BASE_CFG 默认 0，从未消融）：我方回合结束后，
 * 下一位对手贪心最佳行动的分数按权重从己方候选价值中扣减——4 人非零和
 * 按各自最大化建模（上游 mcts-stage3 同款）。仅对价值前 opponentResponseK=2
 * 名首动候选评估，成本 ≈ 每候选一次额外全量打分（无 rollout，~2min/局）。
 *
 * 其余与 jsb-v20260903 完全一致。单变量归因：E20 = w∈{0.3, 0.6} 两臂
 * ×20 vs 0903（bench/docs/2026-10-13-e20-maxn-verdict.md）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'zjk-v20261013-maxn',
    version: '2.0.0',
    description: '0903 + opponentResponseWeight=0.3（MaxN 对手回应，E20）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5, opponentResponseWeight: 0.3 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0 },
  },
  tuneEnvVar: 'BRASS_TUNE9',
});
