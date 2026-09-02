/**
 * lm-heuristic-v20260829：启发式 AI——Eluvk/brass-assistant 2026-08-29 重构版
 * （engine/src/ai/heuristic_ai/，15 个 Rust 文件）的单文件 TS 移植。
 *
 * 与上游模块一一对应的分节：
 * - config        → config.rs：全部权重/阈值/开关，数值逐字照抄。
 * - context       → context.rs：EvalContext（相位、per-phase 权重、剩余轮数、
 *                   货币折算、时代谓词）。round/era 进度按本引擎改用卡牌计量
 *                   （本引擎 round 跨时代累计，v1 已验证的映射）。
 * - value         → value.rs：ScoreParts 评分分解（vp/money/income/flex/
 *                   strategic/risk）+ 市场模型（simulate_market_sale /
 *                   market_scarcity / price_heat）+ Link 图标估值。
 * - board         → board.rs：共享盘面查询（商人可达、啤酒可得、孤岛、
 *                   免费搭车比率、自家 overbuild VP 损失……）。
 * - probability   → probability.rs：统一翻面概率模型（资源/酒厂/可售三 regime）。
 * - plan          → plan.rs：四相位 + 生产计划（流派）选择。
 * - cards         → cards.rs：手牌保留价值（card-selection head）。
 * - build/network/develop/sell/loan/scout_pass → 同名 .rs 的各行动评分。
 * - lookahead     → lookahead.rs：确定性 2-ply 同回合前瞻 choose_action。
 *
 * 结构差异（语义忠实、载体不同）：上游 scorer 直接对"目标枚举"（BuildTarget
 * 等）打分并自行组装 ResolvedMove；本插件对 engine enumerateActions 产出的
 * legal Action 逐条打分，操作分不含弃牌维度，同操作不同 cardId 的并列以
 * 保留价值最低者优先——等价于上游"操作/选卡两个策略维度分离"的语义。
 *
 * 有意未移植：evaluate_position / estimate_player_vp（MCTS 叶评估器，插件
 * 契约用不到）、distinct_source_options / SOURCE_VARIANTS（MCTS 候选宽度，
 * 本引擎 legal 已含资源来源变体）。develops_in_canal/rail 计数本引擎状态
 * 无此字段，由插件实例按自身决策追踪（只统计自己的 develop 行动，语义一致）。
 *
 * 2026-09-02 重构：本文件为 heuristic-core 的配置壳——本版 = BASE_CFG
 * 关闭全部 jsb 自研机制（忠实上游数值）；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'lm-heuristic-v20260829',
    version: '2.0.0',
    description: '启发式评分 AI（统一翻面概率模型，Eluvk/brass-assistant 2026-08-29 重构版忠实移植）',
    author: 'Eluvk/brass-assistant（移植）',
  },
  overrides: {
    value: { canalDoubleScoreScale: 0 },
    flip: { realBeerNeed: 0, merchantScarcityWeight: 0, sellActionWindow: 0 },
    sell: { canalEndL1Bonus: 0, railLateVpScale: 0, batchBonus: 0, vpScaleFloor: 0.1 },
    network: { railCertaintyBonus: 0 },
    lookahead: { firstActionK: 3 },
    leaf: { weight: 0 },
  },
});
