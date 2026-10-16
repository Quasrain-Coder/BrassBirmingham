/**
 * zjk-v20261013-crn：0906-rollout + 推演复核共同随机数（CRN）。
 * （实验时 spec 名 jsb-v20260929-crn，2026-10-13 命名规范改为 zjk- 前缀；日期同步修正）
 *
 * E17→E18 稀释（70%→56.7%）的机理假设：候选间推演取独立随机流（旧种子含
 * 候选序号 i），K8 下两候选均分差 std≈10VP 而 margin=3.0，~38% 翻盘改选
 * 为纯噪声触发——信号被噪声淹没。CRN（同 k 跨候选共用随机流）配对抵消
 * 推演噪声，同等 K 数下改选判定收紧；顺带修掉 top[0] 确定性重复推演的浪费。
 *
 * 其余与 jsb-v20260906-rollout 完全一致（K8/topK2/delta2.0/margin3.0），
 * 单变量归因：E19 = CRN on/off ×20 vs 0903（bench/docs/2026-10-13-e19-crn-verdict.md）。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'zjk-v20261013-crn',
    version: '2.0.0',
    description: '0906-rollout + rolloutCrn=1（推演复核共同随机数，E19）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5, rolloutK: 8, rolloutDeltaThreshold: 2.0, rolloutCrn: 1 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0 },
  },
  tuneEnvVar: 'BRASS_TUNE8',
});
