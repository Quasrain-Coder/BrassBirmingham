# prescreen 贷款评分对齐（2026-09-05）

第 1 轮 GLM-5.3-Flash vs jsb-v20260903 复盘（见 `2026-09-05-glm-vs0903-round1.md`）
暴露的结构性问题：**LLM 的候选列表来自 prescreen 轻量评分器（scoreAction topK=20），
而获胜 bot（heuristic-core CFG 评分）的 9.1% 实际决策排在 prescreen 第 20 名开外**
——LLM 的候选窗根本看不到这些冠军级动作，其中贷款类占 46%（118 次，收入
5→2 / 9→6 / 21→18 的健康收入位贷款全部 rank 20-84）。

## 根因（scoreLoan 三处结构性低估）

1. **无 combo 项**：贷款单看"什么都没干"，而 heuristic-core 的 scoreLoanOp 有
   comboScale 项（贷后本回合还能做的最佳正分行动 ×0.7）——bots 的贷款优势
   在 prescreen 排名里完全不可见（2-ply 前瞻只存在于 HeuristicAgent.pick，
   不参与 LLM 候选排名）。
2. **富有罚分一刀切**：cash 30/42/55 三档罚 1.0/2.4/5.0，不看贷后收入——
   终局收入不折 VP，健康收入位的"贷款→当场翻面转 VP"是赢家常规武器。
3. **gain = after − now 在现金充裕时恒 0**：终局现金本来就花不完，贷款的
   真实增益是"凭空多做一件可负担建设"，不是与当前预算的差值。

## 修复（heuristic/other.ts scoreLoan）

- 显式 combo 项：`cash < 24 && roundsRemaining > 1.5` 时 `+max(0, after) × 0.7`
  （与 heuristic-core comboScale 同款同门限）；
- 健康收入位豁免：贷后收入 ≥6 的收入成本归零、≥3 打 2.5 折；富有罚分同门限
  减档（×0.3 / ×0.6）；
- 终局增益修正：`roundsRemaining ≤ 2` 时 `gain = max(gain, after × 0.7)`。

## 前后对照（bench/prescreen-audit.ts，16 局 4×0903 bot 同种子重放，seeds 7000-7015，1984 决策）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| bot 决策 rank>20 占比 | 6.20%（123） | **4.33%（86）** |
| 其中贷款 | 48 | **9（−81%）** |
| 其中搜寻 | 30 | 31（不修——prescreen 低排搜寻与第 1 轮「搜寻降权」复盘建议同向） |
| 其中双轨 | 25 | 25（待逐例分析，下轮迭代） |

单元测试 49/49 通过；本修复只影响 LLM 候选列表质量、chosenRank 复盘锚点与
HeuristicAgent 降级路径，**不影响 jsb-0903 插件本体**（其用 heuristic-core CFG
评分）。LLM 侧收益待第 3 轮同种子 A/B 验证。
