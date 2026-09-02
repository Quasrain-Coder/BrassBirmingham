/**
 * jsb-v20260901：启发式 AI 调优版——基于 jsb-v20260831 继续迭代
 * （brass-assistant 2026-08-29 重构版移植），叠加本项目自研引导。
 *
 * 配置定案（S3，2026-09-01，PAIRED 完全配对基准；相对 jsb-v20260831）：
 * - **规则级修正**：value.canalDoubleScoreScale 1.0——运河翻面的 L2+ 板块
 *   两时代各计一次 VP（era.ts scoreFlippedIndustries 跑两遍，L1 运河末移除），
 *   此前评分只计 1×，系统性低估运河 L2+（最大单项增益：69%+62% vs 0831）。
 * - 精度修正：flip.realBeerNeed 1（按真实 beerToFlip=2 估制造 L5/陶 L3/L5）、
 *   flip.merchantScarcityWeight 1.0（商人需求格 < 全场待翻板块时折价）、
 *   flip.sellActionWindow 1（剩余动数卖不完库存 → flipProb 压 floor）。
 * - 行为引导：sell.batchBonus 1.5（攒批出售）、sell.vpScaleFloor 0.25
 *   （运河出售折现地板，内战均分 109.4→110.2）、lookahead.firstActionK 5。
 * 终验（PAIRED n=100-200/组）：vs jsb-0831 69.5%（S2D）/63%（S3）；
 * vs lm-0829 77%；vs lm-0826 87%；内战 4p×100 人均 110.2（基线 109.9）。
 * 迭代全史见 bench/docs/2026-09-01-jsb0901-optimization.md。
 *
 * 2026-09-02 重构：本文件为 heuristic-core 的配置壳——本版 = BASE_CFG
 * 关闭局面估值叶（leaf.weight 0）；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260901',
    version: '2.0.0',
    description: '启发式评分 AI 调优版（0831 迭代：运河 L2+ 双计分修正 + 翻面精度/出售引导）',
    author: 'brass-birmingham',
  },
  overrides: {
    leaf: { weight: 0 },
  },
  tuneEnvVar: 'BRASS_TUNE2',
});
