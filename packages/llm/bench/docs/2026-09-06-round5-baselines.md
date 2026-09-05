# 基线阶梯：从 prescreen Top-1 到 0903 完整版的棋力分布（2026-09-06）

同种子（5000-5029）×4 席同质对局，量化「评分器每层能力」的 VP 贡献与
LLM 自由选择的位置。这是 ②（评分器迭代）的基线参照，也是 ①（LLM 座位
兜底模式）的选型依据。

## 阶梯（4p 人均 VP）

| 层 | 配置 | 人均 | 增量 |
|---|---|---|---|
| L0 | prescreen Top-1（argmax，无前瞻） | ≈94.6 | — |
| L1 | + 2-ply 同回合前瞻（HeuristicAgent） | ≈100.2 | **+5.7** |
| L2 | + 完整 CFG（leaf realFlipProb 0.9 / fourAction 0.5 / flip 惩罚，即 0903 插件） | ≈114（内战参照，2026-09-03 F2） | ≈+14 |
| — | LLM 自由选择（5 个 prompt 变体，a-e 组） | 68-88 | 负增量 −8~−24 vs L0 |

脚本：`bench/baseline-2ply.ts`（L1）；argmax 见 argmax-architecture.md。

## 结论

1. **2-ply 前瞻值 +5.7 VP/局**：LLM 座位兜底选 HeuristicAgent（L1）而非
   Top-1——已落地为 `BRASS_AI_LLM_MODE` 缺省 heuristic（PR #69）。
2. **评分器内部仍有 ~14 分未兑现**（L1→L2 的 leaf/realFlipProb/fourAction
   组合）：这是②的迭代空间，且全部可配对终验。
3. **LLM 的位置**：即使最好的 prompt 变体（c2 组 87.7）也低于 L0。
   端到端验证 f0（LLMAgent heuristic 缺省 ×10）= 91.3（LLM 席位轮换口径，
   与 L0 同席位基线 89.3 一致），确认模式切换无回归。

## 与 0903 的差距分解（对 LLM 席位）

- 兜底从 L0 升到 L1：+5.7（已兑现，PR #69）
- 兜底从 HeuristicAgent 升到 0903 插件本体：≈+14——直接可行！LLMAgent 的
  fallback 可以换成 createAgent('builtin:jsb-v20260903')——待验证
  （heuristic-core 与 heuristic.ts 评分体系不同源，2-ply 口径不同）。
  若成立，LLM 座位 = 0903 级棋力（~114）而零 API 成本。
