---
name: brass-llm-player
description: 在 BrassBirmingham 仓库内迭代 LLM player（packages/llm 的 LLMAgent/prompt/预筛）时使用——跑自对弈 bench、分析 trace、A/B 策略变体、修候选排名问题、把有效经验晋升进生产 SYSTEM_PROMPT。当用户要求"迭代 llm player""改进 AI 棋力""跑自对弈""对比策略变体""为什么 AI 分数低/负分""做成 skill"或做任何 packages/llm 相关改进时必须使用。编码迭代闭环：基线→假设→A/B→analyze→晋升。
---

# LLM Player 迭代（BrassBirmingham）

迭代对象是 `packages/llm` 的决策链：`prescreen`（候选预筛）→ `buildDecisionPrompt`（system+user）→ `LLMAgent.decide`（LLM 选 + 校验 + 降级）。**规则永远只在 `packages/engine` 结算**，llm 只做选择。

## 迭代闭环（每次迭代走完一圈）

```
基线 → 提假设 → 改一处 → A/B 自对弈 → analyze → 晋升/回滚 → 记录 ITERATION.md
```

1. **先看经验**：读 `packages/llm/bench/docs/ITERATION.md` 的历史版本记录与"关键洞察"（已沉淀的坑别再踩）。
2. **基线**：当前生产代码即基线；改动前先跑一版基准（可复现）。
3. **一次只改一个变量**：prompt 变体（`bench/variants.ts`）、候选消毒、权重、topK 等分开改，否则无法归因。
4. **A/B 验证**：`llm:<difficulty>@<variant>` 打旧版，镜像换边（--mirror 消除座位偏差）。
5. **analyze**：`bench/analyze.ts` + 自写统计（chosenRank 分布 / action kind / 负分率 / pass 率）。
6. **晋升**：数据证明有效的策略段合入 `summarize.ts` 的 `SYSTEM_PROMPT` 本体，删变体；无效丢弃。代码级修复（候选消毒/去重/权重）直接进生产并补测试。

## 自对弈 bench（验证方式）

```bash
# 真实 LLM（需 BRASS_AI_MODEL 指向网关可用模型；见下）
BRASS_AI_MODEL="DeepSeek-V4-Flash-0731" npm run bench -w @brass/llm -- \
  --agents llm:normal,llm:normal --games 10 --seed-base 101 --mirror \
  --concurrency 4 --out bench/out/<runId>

# 纯启发式（免费秒级，验证候选/权重改动不炸）
npm run bench -w @brass/llm -- --agents heuristic,heuristic --games 20 --seed-base 1 \
  --mirror --concurrency 8 --out bench/out/<runId>
```

**铁律**：
- `--out` 目录**必须全新**——`TraceWriter` 会拒绝写入已有 games.jsonl 的目录（防 R1 那种两次跑批混合污染）。
- 镜像必须开（2p 对比消除先手偏差）。
- 同 seed 集跨轮可比：固定 `--seed-base`。
- 2p 对局一局约 5 分钟（DeepSeek 网关），10 种子 × 镜像 = 20 局 ≈ 25 分钟，concurrency 4。

**汇总指标**（bench 已打印）：胜率、平均 VP、平均 VP 差、**负分率**（稳定性核心）、degraded 率、token。

## 失败定位（analyze）

```bash
node_modules/.bin/vite-node packages/llm/bench/analyze.ts packages/llm/bench/out/<runId>
```

- **chosenRank 分布**：恒 0 → LLM 无增量（预筛即上限，去查 HEURISTIC_WEIGHTS/预筛）；常偏离 0 且输 → 候选内选错（改 prompt/候选集）。
- **action kind 频率**（建/铺/卖/研发/贷/侦察/跳过）：结构性偏差（sell 过低 = 翻面引擎闲置；pass 过高 = 模型摆烂或候选排名差）。
- **degraded 率**：>5% 说明网关/模型有问题，先修再谈棋力。

## 候选排名 = LLM 决策的上限（本技能最核心的经验）

LLM 只在 prescreen 给它的候选里选。候选排名烂，prompt 再好也没用。已落地修复（**不要回退**）：

1. **cardId 去重**（`prescreen`）：legal 里大量行动只差弃哪张卡（开局实测 511→134 种选择），旧逻辑把同一 develop 重复 15 次塞满 topK。每种选择只留最高分代表。
2. **自杀贷款消毒**（`prescreen`）：贷后收入 < 0 的贷款移出 LLM 候选——负收入每轮从 VP 扣钱，是破产螺旋唯一来源。heuristic 的 loan 评分（现金<£5 就 +5）会把 0→-3 的贷款排到候选#1，模型"看到最优是贷款但被禁"→ 直接 pass。
3. **pass 权重必须为负**（`HEURISTIC_WEIGHTS.pass = -5`）：pass=0 在贷款消毒后变成候选#1，模型 86% pass。候选排名里 pass 必须明显垫底。
4. **chosenRank 对"LLM 可见候选集"算**（`drive-game.ts rankOf`）：rank 应对 prescreen 消毒+去重后的集合算，对全量 legal 会把被消毒的贷款算进去导致失真。

**教训链**：修掉一个坏候选（贷款），下一个坏候选（pass）就冒出来——每次改动后必须看 action kind 分布，系统性审每个行动类型的排名合理性。

## 模型能力边界（当前网关实测）

- 网关（`ANTHROPIC_BASE_URL`）只有 `DeepSeek-V4-Flash-0731`（`BRASS_AI_MODEL` 覆盖）；`claude-sonnet-4-5`/`k3[1m]` 等均 404。`llm-agent` 已支持 `BRASS_AI_MODEL` 覆盖。
- **DeepSeek-V4-Flash 基本不会玩 Brass**（R2 六组实验）：pass 率 70%+、常打 0-0 平局、最高 VP ≤ 44。它把"现金不够"当无路可走，忽略卖货（不要现金）/£3 运河/研发/侦察。改 prompt 措辞、候选数量都不改变行为。
- 因此：**在 DeepSeek 上磨棋力意义有限**；基础设施（候选消毒/去重/负分率/bench 卫生）是确定收益，已落地。换到能干活的模型时，本 skill 的闭环与经验直接复用。
- 负收入机制（`turn.ts payNegativeIncome`）：收入负时每轮从现金扣→拆板块→VP 兜底（可为负）。VP 轨唯一扣减点，负分 = 破产信号。

## 迭代记录

每次跑完一轮更新 `packages/llm/bench/docs/ITERATION.md`（版本表格 + 关键洞察），经验才跨会话可复用。
