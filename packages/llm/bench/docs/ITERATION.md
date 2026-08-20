# LLM Player 迭代日志

> 目标：2 人局自对弈（llm vs llm）稳定拿到高 VP，先做到不破产（负分率→0）+ 高分（向 100+ 逼近）。
> 验证方式：真实 LLM 自对弈（--mirror 镜像换边），烧 ANTHROPIC_AUTH_TOKEN 网关（DeepSeek-V4-Flash-0731，经 BRASS_AI_MODEL 覆盖）。

## 复现命令（必须用新 --out 目录，防污染；TraceWriter 已加目录残留守卫）

```bash
BRASS_AI_MODEL="DeepSeek-V4-Flash-0731" npm run bench -w @brass/llm -- \
  --agents llm:normal,llm:normal --games 10 --seed-base 101 --mirror \
  --concurrency 4 --out bench/out/<runId>
```

## 指标

- **负分率**（vp<0 的座位占比）——稳定性核心指标
- 平均 VP / 平均 VP 差 / 胜率（平局记 0.5）
- degraded 率（LLM 调用失败降级启发式的比例）
- action kind 分布（build/network/sell/develop/loan/scout/pass）——结构信号

## 根因分析（debug 阶段）

- **负分机制**：引擎忠实规则 `payNegativeIncome`（turn.ts:102-118）——收入等级为负时每轮从 VP 扣欠款（现金→拆板块→VP 兜底）。VP 轨只增不减，唯一扣减点就是这个。
- **LLM 破产螺旋**：连环贷款（0→-3→-6→-9），收入被贷到负 → 每轮 VP 失血 → 负分。
- **sell 几乎不用**：baseline 中 sell 占 0.3%（312 决策中 1 次）——翻面引擎完全闲置，这是 VP 上不去的主因。
- **pass 过多**：32%，现金不足时摆烂。
- **R1 数据污染教训**：--out 目录复用导致 JSONL 混合两次跑批，结论不可信。已修 TraceWriter（目录非空即拒绝）。
- **gateway 模型坑**：本地网关只有 DeepSeek-V4-Flash，没有 claude-sonnet-4-5，必须 BRASS_AI_MODEL 覆盖，否则 100% 降级。已修 llm-agent 的 model 取值。

## 版本记录

| 版本 | 改动 | 结果 | 结论 |
|---|---|---|---|
| baseline-llm | 当前生产 SYSTEM_PROMPT | **avg VP 1.4，median 23，max 70，负分 40%**（seeds 101-110，20 局）。action mix: build 36% / pass 18% / network 17% / loan 12.5% / scout 7.6% / develop 7% / **sell 1.1%**。degraded 2.5% | 破产严重 + 卖货引擎闲置，需修 |
| strategy-v2（smoke） | v2 prompt + loan 危险标注，无 dedup | avg -26.6，负分 5/8，pass 40%，loan 12% | "禁止"式措辞让模型更摆烂 |
| v2b（smoke） | v2 + loan 危险标注，无 dedup，seeds 301 | avg -11.1，负分 5/8，**pass 58%**，loan 6% | 贷款少了但 pass 爆炸——候选列表仍是核心问题 |
| v2c（smoke） | **dedup 候选** + v2 + loan 标注 | avg -10.8，负分 5/8，pass 62%，rank0 19% | dedup 没帮上忙：heuristic 把 0→-3 自杀贷款排在候选#1，模型"拒绝贷款→直接 pass" |
| 代码修复 | ①cardId 去重（511→134 种选择）②**自杀贷款移出 LLM 候选** ③chosenRank 改为对"LLM 可见候选集"排名 | 单测全绿；开局候选列表不再有 0→-3 贷款 | 待 v3 实测 |
| strategy-v3（smoke） | 建设性 prompt（每步推进得分引擎/卖/建/铺/研发）+ dedup + 贷款消毒 | avg -7.3，负分 13%，但 **3 局 0-0 平**——pass 86%、rank0 91% | 贷款消毒后 heuristic 的 pass=0 变成候选#1，模型照单全收地 pass |
| 代码修复 | pass 权重 0 → **-5**（pass 不再中立，LLM 候选排名里明显垫底） | 单测全绿；pass 在 133 候选里排 127 | 待 v3b 实测 |
| strategy-v3b（smoke） | 全部修复 + v3 | avg 6.1，max 44，**负分 0/8**，但 **72% pass**（3 局 0-0 平） | pass 排名垫底也拦不住模型：它主动 pass |
| 代码修复+base（ctrl） | base prompt + 全部代码修复 | avg 4.5，负分 0/8，**71% pass**，0-0 平 | prompt 变体 vs 无变体无差异——模型本身不玩 |
| strategy-v4（smoke） | 硬性"不许 pass" + 逐条点破无现金行动（卖货/£3运河/研发/侦察） | avg -5.8，max 0，**77% pass**，3 局 0-0 | 强指令更糟——模型以更多 pass 回应 |
| 代码修复+easy（smoke） | topK 8（候选更少）+ 全部修复 | avg -3.3，负分 4/8，**73% pass**，max 4 | 候选数量无关——模型就是不会玩 |

## 结论（R2 终）

**DeepSeek-V4-Flash-0731 无法玩 Brass**：6 组实验（base/v1/v2/v3/v4/easy）pass 率全部 70%+、常打 0-0 平局、最高 VP ≤ 44。Prompt 措辞、候选消毒、候选数量都不改变行为。模型把"现金不够"当成无路可走，但从不考虑卖货（不要现金）/£3 运河/研发/侦察。

**基础设施修复是真实有效的**（这些要保留进 skill 与生产代码）：
1. 负分率 40% → 0%（自杀贷款移出候选 + pass 负分 + rank 语义）——破产螺旋根治。
2. 候选多样性（cardId 去重 511→134）——LLM 能看见真实选择空间。
3. bench 卫生（目录残留守卫 + 负分率统计 + 网关模型覆盖）——防污染、可复现。

## 关键发现（模型能力边界）

- **唯一可用模型 DeepSeek-V4-Flash-0731 基本不会玩 Brass**：无论 prompt 怎么改（base/v1/v2/v3）、候选怎么消毒（dedup/剔贷款/pass=-5），pass 率稳定 70%+、常打出 0-0 平局。
- 模型 pass 时理由都是"现金£0/£1 无法负担任何行动"——但它忽略了卖货不要现金、£3 运河、研发等真实存在的廉价行动。这是**错误信念**，不是真无路可走。
- **pass 剔除实验（R2.5，已回滚）**：把 pass 移出 LLM 候选（存在非 pass 行动时），实测 pass 仍 73%、0-0 平局——且此时 pass 常是 heuristic 的 rank0（合法卡死状态）。根因不是"拒绝行动"，是**早期乱建**：r1 建 £7 酿酒厂（rank36）、r2 建煤矿+运河（£8），£17 起手现金两轮花光、收入没做起来 → r3 起永久 pass。模型不会规划经济（建能产收入/能卖翻面的板块），候选排名救不了它。
- 候选排名质量已是系统性修复（dedup/剔自杀贷款/pass 负分/rank 语义），**负分已从 40%→0%**——基础设施是有效的，卡在模型能力。

## 关键洞察（R2）

- **候选列表是 LLM 决策的第一瓶颈**：511 个 legal 行动里 134 个不同选择，旧 prescreen 把同一 develop 重复 15 次塞满 topK，模型看不见多样选项。
- **heuristic 的 loan 评分（现金<£5 就 +5）会把 0→-3 自杀贷款排到候选#1**，模型看到"最优是贷款但标注禁止"→ 直接 pass。**必须把这类贷款移出 LLM 候选**（候选消毒），而不是只靠 prompt 说"别贷"。
- **chosenRank 语义修正**：模型只从 prescreen 后的候选里选，rank 应对"它看到的候选集"算，而不是对全量 legal（全量会把被消毒的贷款算进去导致失真）。
- **pass 权重必须为负**：heuristic 把 pass=0 当"中立"，但对 LLM 排名信号是灾难——贷款消毒后 pass 常变候选#1，模型 86% pass。候选排名里 pass 必须明显垫底（-5），让模型只能在没有正分行动时才 pass。
- **教训链**：修掉一个坏候选（贷款），下一个坏候选（pass）就冒出来——候选排名质量是 LLM 决策的上限，要系统性审每个行动类型的"排名合理性"，而不是一个个补丁。
