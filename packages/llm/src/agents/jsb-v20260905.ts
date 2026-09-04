/**
 * jsb-v20260905：基于 jsb-v20260903 的调参候选（2026-09-05 GLM-5.3-Flash
 * 对局复盘驱动，×30 局三组复盘收敛的 0903 行为缺陷）：
 *
 * 1. 搜寻过度（a2：5020 P1 两次搜寻垫底、5028 P3 三次搜寻 16VP 运河末全场第 4、
 *    5021 P1 seq38、5023 P3 seq18/30）——每回合 tempo 价值 ~2VP，maxRefresh
 *    5.0→3.0、deadDiscardValue 0.96→0.72 压低非死牌场景的搜寻吸引力。
 * 2. 负收入贷款尾部灾难（a0：5004 P1 破产 0 分，深研发+负收入贷款锁死 10 连
 *    跳过；a2：5020/5021/5023/5026 贷至 -4~-6）——收入地板收紧：deep -7→-4、
 *    debt -4→-3，罚分 7→9 / 2→3。
 * 3. 终局现金滞留（a0：£28-£107 未花，5007 冠军只赢 1 分；a1：高收入位贷款被
 *    富有罚分压制，实际终局收入不折 VP≈免费）——富有罚分放宽（heavy 55→45、
 *    5→3；moderate 42→36、2.4→1.5），鼓励贷款把现金转成当场翻面的 VP。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 * 验证门槛：vs 0903 PAIRED ≥50% 且人均 VP 不降，才替换默认。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260905',
    version: '2.0.0',
    description: '启发式评分 AI 调参候选（0903 复盘迭代：搜寻降权/负收入地板收紧/富有罚分放宽）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0 },
    scout: { maxRefresh: 3.0, deadDiscardValue: 0.72 },
    loan: {
      floorDeepDebtIncome: -4,
      floorDeepDebtPenalty: 9.0,
      floorDebtIncome: -3,
      floorDebtPenalty: 3.0,
      richHeavyCash: 45,
      richHeavyPenalty: 3.0,
      richModerateCash: 36,
      richModeratePenalty: 1.5,
    },
  },
  tuneEnvVar: 'BRASS_TUNE6',
});
