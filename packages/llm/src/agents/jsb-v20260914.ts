/**
 * jsb-v20260914：内战均分 130+ 目标版——基于 jsb-v20260911。
 *
 * 方向（2026-09-14，终局动作预算 + 翻面保障强化）：
 * - 终局审计（0911, 5局）：每局仅 0.8 块未翻面（0831 时 2.3 块），但剩余
 *   4 块均为高值板块（manu L2/iron L4/pottery L3），人均损失 ~7.5 VP 面值。
 *   强化 railSellableNoOwnBeerPenalty 2.0→3.0：无自有酒桶的可售板块
 *   更不敢建（建了翻不了 = 纯亏）。
 * - 轨迹分析（seed0）：P3 在 R16 末轮连续贷款两次（收入 23→17），£60
 *   换不到 VP 还白亏收入。新增 endgameLoanPenalty：末轮（roundsRemaining<1.5）
 *   贷款额外罚分——末轮每个动作必须直接换 VP。
 * - 卖出紧迫度强化：urgencyBonus 3.0→5.0 + railLateVpScale 0.3→0.5，
 *   末段卖高值板块优先于再建新的。
 *
 * 快筛结论（2026-09-14）：MCTS 扩容（sims40→100/150）无效（123.0 vs 基线
 * 124.6）；heuristic 调优（leaf.moneyShare=0.7 / sell.vpScaleFloor=0.35 /
 * inventoryUrgency=0.5 / firstActionK=8）全部拖后腿（消融 -0.7~-5.9）。
 * 0911 基线 124.6 为当前最优，本版在其上做终局专项强化。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260914',
    version: '1.0.0',
    description: '内战均分 130+ 目标版（0911 + 终局动作预算 + 翻面保障强化）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: {
      railSellableNoOwnBeerPenalty: 3.0,
      canalCoalFlipDiscount: 0.7,
      breweryRailFlipFloor: 0.85,
      breweryRailFlipDecayWindow: 8,
      breweryRailFlipLateFloor: 0.6,
    },
    sell: {
      ownBreweryFlipCredit: 1.0,
      opponentBreweryFlipPenalty: 1.0,
      urgencyBonus: 5.0,
      railLateVpScale: 0.5,
    },
    network: {
      unflippedIconCoefficient: 0.6,
    },
    develop: {
      endgameZeroRound: 1.5,
    },
    loan: {
      endgameRoundsThreshold: 1.5,
      endgameLoanPenalty: 5.0,
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
  tuneEnvVar: 'BRASS_TUNE14',
});
