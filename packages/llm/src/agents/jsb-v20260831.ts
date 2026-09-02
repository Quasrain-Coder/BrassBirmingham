/**
 * jsb-v20260831：启发式 AI 调优版——基于 lm-heuristic-v20260829
 * （brass-assistant 2026-08-29 重构版移植），叠加本项目自研引导。
 *
 * 配置定案（C6 消融链 ×500 终验，2026-08-31：62.6% vs 母体 36.2%，平 6，
 * 座位均分 111.4 vs 107.5）：
 * - 有效项（相对母体的全部差异）：sell.canalEndL1Bonus 3.0（运河末 L1 清仓）、
 *   sell.railLateVpScale 0.3（铁路末段高价值兑现）、network.railCertaintyBonus
 *   0.7（铁路 Link 确定性溢价——低值建筑不如修高分路）。
 * - 净负项（代码保留、默认关闭）：收官窗系列（sellWindow/resourceWindow/
 *   breweryWindow）、库存队列衰减、流派跳级罚、对手改建定价；ownOverbuildVpLoss
 *   与 develop.planBonus 回母体值（1.0 / 0.3）。
 * （建酒厂+出售 combo 经消融外战验证为负优化，已移除并记录于核心注释。）
 * 迭代全史见 bench/docs/2026-08-31-jsb-optimization.md。
 *
 * 2026-09-02 重构：本文件为 heuristic-core 的配置壳——本版 = BASE_CFG
 * 关闭 0901/0902 新增机制（双计分/翻面精度/出售引导/局面估值叶）；
 * 核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260831',
    version: '2.0.0',
    description: '启发式评分 AI 调优版（lm-0829 移植 + 收官窗口/库存衰减自研引导）',
    author: 'brass-birmingham',
  },
  overrides: {
    value: { canalDoubleScoreScale: 0 },
    flip: { realBeerNeed: 0, merchantScarcityWeight: 0, sellActionWindow: 0 },
    sell: { batchBonus: 0, vpScaleFloor: 0.1 },
    lookahead: { firstActionK: 3 },
    leaf: { weight: 0 },
  },
  tuneEnvVar: 'BRASS_TUNE',
});
