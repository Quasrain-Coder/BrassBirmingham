/**
 * zjk-v20261013-scoutroll：jsb-v20260905(v905a) + rollout 复核组合。
 *
 * 两个独立弱正信号的叠加复验（非可加性警告在案，须实测）：
 * - v905a 搜寻降权（jsb-v20260905）：×300 53.7%±5.7%，方向正未达门槛；
 * - rollout 复核（jsb-v20260906-rollout，E17/E18）：×120 56.7%。
 * 若近似可加 → ~60% 区间，有望达仓库切默认门槛（56-63% ×500）。
 *
 * rollout 参数取 E18 验证过的原配置（独立随机流，rolloutCrn=0——E19 证明
 * CRN 无收益）；scout 参数与 0905 完全一致。
 * 单变量归因基准：E21 = 本插件 vs 0903 ×20（bench/docs/2026-10-14-…）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'zjk-v20261013-scoutroll',
    version: '2.0.0',
    description: 'v905a 搜寻降权 + rolloutK8 复核（E21 组合消融）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5, rolloutK: 8, rolloutDeltaThreshold: 2.0 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0 },
    scout: { maxRefresh: 3.0, deadDiscardValue: 0.72 },
  },
  tuneEnvVar: 'BRASS_TUNE10',
});
