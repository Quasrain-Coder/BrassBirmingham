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
export const STRATEGY_VARIANTS: Record<string, string> = {
  'strategy-v1': [
    '策略要点：',
    '- 翻面是 VP 与收入的引擎。建造只是投入，翻面才兑现：煤/铁/酿酒厂耗尽资源自动翻面，棉纺/制造/陶瓷必须靠卖出翻面。建消费类板块（棉纺/制造/陶瓷）前确认有卖货路径（连通对应图标的商人 + 啤酒来源）；场上已有未翻面的消费类板块且能卖时，卖出通常优先于继续新建。',
    '- 贷款经济：现金见底且后续还要建造时，尽早贷款（运河时代贷款几乎总是对的，£30 换收入退 3 级很划算）；铁路时代最后 3 轮不要再贷——收入损失收不回来。',
    '- 侦察（弃 3 换 2 Wild）代价很大：仅当手牌完全无法支持任何有价值的行动时才用，每局一般不超过 1 次。',
    '- 研发优先级：先清除 1 级板块（除陶瓷外 1 级板块铁路时代不可建、运河时代末强制移除，留着会卡面板）；其次解锁高级棉纺/制造（高级板块 VP/收入高得多）。',
    '- 啤酒规划：卖出耗啤酒，酿酒厂建成只在运河时代放 2 桶/铁路时代 1 桶。大规模卖货前先确保啤酒来源（自己酒厂余桶、连通商人桶），别在建酿酒厂上拖延。',
    '- 时代过渡：运河时代末别新建 1 级非陶瓷板块（马上被移除）；留意本时代剩余轮数，提前为铁路时代的高级板块攒连通与现金。',
  ].join('\n'),
};

/** spec 解析：`llm:<difficulty>[@<variant>]` → { difficulty, systemExtra? }。 */
export function parseLlmSpec(
  spec: string,
): { difficulty: string; systemExtra: string | undefined } | null {
  const m = /^llm:([a-z]+)(?:@([a-z0-9-]+))?$/.exec(spec);
  if (!m) return null;
  const variant = m[2];
  if (variant !== undefined && !(variant in STRATEGY_VARIANTS)) {
    throw new Error(
      `未知策略变体 @${variant}（可用: ${Object.keys(STRATEGY_VARIANTS).join(', ')}）`,
    );
  }
  return {
    difficulty: m[1]!,
    systemExtra: variant !== undefined ? STRATEGY_VARIANTS[variant] : undefined,
  };
}
