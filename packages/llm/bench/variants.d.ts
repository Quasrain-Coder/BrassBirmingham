/**
 * bench 策略变体：A/B 互搏用的 system prompt 追加段。
 *
 * 用法：`--agents llm:normal@strategy-v1,llm:normal`（新旧互搏，同难度不同
 * 策略段）。LLMAgent 经 opts.systemExtra 注入；'base'/省略 = 不追加（当前
 * 生产 SYSTEM_PROMPT 原样）。
 *
 * 变体验证有效（双基线都不劣化）后，内容应合入 summarize.ts 的 SYSTEM_PROMPT
 * 本体、删除对应变体——这里只是迭代期的临时持有处。
 *
 * strategy-v1 针对 base-llm20 基线（20 局：llm 胜率 30%）实测暴露的问题：
 * - sell 只占 2%（棉纺/制造/陶瓷翻面引擎闲置）→ 强调卖货翻面节奏；
 * - 贷款 12% 且铁路末轮仍在贷 → 明确贷款经济窗口；
 * - scout 8% 过多 → 限定使用条件；
 * - 87% 决策候选被 topK 截断，sell/develop 易被挤出 → 见 prescreen 类型配额
 *   （heuristic.ts，与本文档独立的另一处改动）。
 */
export declare const STRATEGY_VARIANTS: Record<string, string>;
/** spec 解析：`llm:<difficulty>[@<variant>]` → { difficulty, systemExtra? }。 */
export declare function parseLlmSpec(spec: string): {
    difficulty: string;
    systemExtra: string | undefined;
} | null;
