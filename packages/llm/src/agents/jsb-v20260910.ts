/**
 * jsb-v20260910：真人回放 insight 版——基于 jsb-v20260908。
 *
 * 方向（2026-09-10，真人 vs 0907/0908 回放的三项实证）：
 * - 用桶优先级（sell.ownBreweryFlipCredit / opponentBreweryFlipPenalty）：
 *   出售按引擎规范化消耗顺序模拟啤酒来源——自有酒厂喝干=自己翻面进账,奖;
 *   对手酒厂喝干=送对手免费翻面,罚（回放实证：自有桶空+商人桶充足却
 *   喝干对手最后一桶送翻面）。
 * - 运河煤 flip 折扣（flip.canalCoalFlipDiscount=0.7）：真人回放 AI 造煤
 *   5-7 次 vs 真人 1-2 次;折扣统一传导启发式与 MCTS 推演/叶估值。
 * - 铁路酒厂 flip 地板（flip.breweryRailFlipFloor=0.85）：铁路时代造出
 *   的酒厂不是太末期必被喝掉翻面（真人 5 酒厂全翻 vs AI 仅 0-1 造）——
 *   桶经济是 AI 缺失的核心收益来源。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260910',
    version: '1.0.0',
    description: '真人回放 insight 版（0908 + 用桶优先级/运河煤折扣/铁路酒厂地板）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: {
      railSellableNoOwnBeerPenalty: 2.0,
      canalCoalFlipDiscount: 0.7,
      breweryRailFlipFloor: 0.85,
    },
    sell: {
      ownBreweryFlipCredit: 1.0,
      opponentBreweryFlipPenalty: 1.0,
    },
    ismcts: {
      simulations: 40,
      topK: 4,
      c: 1.0,
      valueScale: 200,
      rolloutPlies: 24,
      policyEpsilon: 0.1,
      gateMargin: 3.0,
      allocator: 'paired',
    },
  },
  tuneEnvVar: 'BRASS_TUNE10',
});
