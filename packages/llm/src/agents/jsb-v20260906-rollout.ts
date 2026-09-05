/**
 * jsb-v20260906：0903 + rollout 复核放量（E17/E18 配置落地为插件 overrides，
 * 供 h2head 单侧对照——env 注入做不到 per-seat）。
 *
 * 配置取自 2026-09-03 迭代 E17/E18：rolloutK=8（价值前 2 名候选各跑 8 局
 * 随机推演到终局，均分显著优者改选）+ rolloutDeltaThreshold=2.0（仅候选
 * 价值接近时触发，控成本 ~4min/局）。E17 小样本 70%（14/20）强信号，
 * 本插件用于 ×40+ 配对终验（bench/docs/2026-09-03-jsb0903-optimization.md）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260906-rollout',
    version: '2.0.0',
    description: '0903 + rolloutK8 推演复核（E17/E18 配置，配对终验用）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5, rolloutK: 8, rolloutDeltaThreshold: 2.0 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0 },
  },
  tuneEnvVar: 'BRASS_TUNE7',
});
