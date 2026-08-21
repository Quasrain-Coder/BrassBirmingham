/**
 * LLMAgent——M3 决策链：预筛 → LLM 选择 → 校验 → 重试一次 → 启发式降级。
 *
 * decide(state, player, legal) 流程（座位在参数上，不绑构造，与 DecidingAgent
 * 契约一致；返回的 action 恒来自调用方给的 legal 集）：
 * 1. prescreen(state, player, legal, topK)：scoreAction 快评取 Top K 候选
 *    （topK 按难度：easy 8 / normal 20 / hard 40）；
 * 2. buildDecisionPrompt（system 静态缓存友好；user = 局势摘要 + 0-based 编号
 *    候选列表，编号与 client 返回的 choiceIndex 对齐）→ client.decide；
 *    hard 难度在 user 末尾附"时代进度与剩余轮数"前瞻段（从 state 的
 *    era/round/actionsPerRound/牌堆与手牌余量估算，供未来两轮规划）；
 * 3. choiceIndex 越界（非整数或不在 [0, candidates)）→ 带错误原因重试一次：
 *    user 末尾追加"上次回复无效：…，请重新选择"；
 * 4. 重试仍无效，或任一调用抛 API 异常（超时/网络/余额）→ 降级 HeuristicAgent
 *    Top-1：degraded=true，reason 记录降级原因，已消耗的 token 仍计入 usage
 *    （重试成功时 usage 为两次调用之和）。
 *
 * DIFFICULTY：easy 用 claude-haiku-4-5（便宜快），normal/hard 用
 * claude-sonnet-4-5；timeoutMs 均 8000、maxTokens 512。
 */
import {
  actionsPerRound,
  type Action,
  type GameState,
  type PlayerIndex,
} from '@brass/engine';
import type { ClaudeClient } from './client.js';
import type { DecidingAgent, Decision } from './decision.js';
import { HeuristicAgent, prescreen } from './heuristic.js';
import { buildDecisionPrompt, describeAction } from './summarize.js';

export type Difficulty = 'easy' | 'normal' | 'hard';

export const DIFFICULTY: Record<
  Difficulty,
  { topK: number; model: string; maxTokens: number; timeoutMs: number }
> = {
  easy: {
    topK: 8,
    model: 'claude-haiku-4-5',
    maxTokens: 512,
    timeoutMs: 8000,
  },
  normal: {
    topK: 20,
    model: 'claude-sonnet-4-5',
    maxTokens: 512,
    timeoutMs: 8000,
  },
  hard: {
    topK: 40,
    model: 'claude-sonnet-4-5',
    maxTokens: 512,
    timeoutMs: 8000,
  },
} as const;

/**
 * hard 前瞻段：时代进度与剩余轮数估算。时代结束条件为"牌堆空且全员手牌空"
 * （turn.ts eraEndCondition），故剩余轮数 ≈ 剩余卡牌总数 / 每轮耗牌数；
 * 每轮耗牌按 玩家数 × actionsPerRound（每人每行动耗 1 张；scout 多耗 2 张的
 * 扰动忽略，标注"约"）。纯估算，仅供 LLM 规划未来两轮。
 */
export function lookaheadSection(state: GameState): string {
  const era = state.era === 'canal' ? '运河时代' : '铁路时代';
  const cardsLeft =
    state.deck.length +
    state.players.reduce((sum, p) => sum + p.hand.length, 0);
  const perRound = state.playerCount * actionsPerRound(state);
  const roundsLeft = Math.ceil(cardsLeft / perRound);
  const after =
    state.era === 'canal'
      ? '本时代结束后清算并进入铁路时代'
      : '本时代结束后终局计分';
  return [
    '',
    `【前瞻：时代进度与剩余轮数】当前为${era}第${state.round}轮，` +
      `本时代预计还剩约${roundsLeft}轮（含本轮，按余牌${cardsLeft}张估算），${after}。` +
      `请评估本行动对未来两轮（翻面节奏、连通铺垫、现金流）的影响。`,
  ].join('\n');
}

/** choiceIndex 无效时的人类可读原因（写入重试 prompt 与降级 reason）。 */
function invalidReason(choiceIndex: number, candidates: number): string {
  // -1 为"无 tool_use / 非整数"哨兵（见 client.ts parseChooseInput）——
  // 区别于显式越界，措辞指明须调用 choose 工具。
  if (choiceIndex === -1) {
    return '未返回结构化选择（须调用 choose 工具提交 choice_index 与 reason）';
  }
  return (
    `choiceIndex=${choiceIndex} 超出候选范围 ` +
    `[0, ${candidates - 1}]（共 ${candidates} 个候选）`
  );
}

function isValid(choiceIndex: number, candidates: number): boolean {
  return (
    Number.isInteger(choiceIndex) && choiceIndex >= 0 && choiceIndex < candidates
  );
}

export class LLMAgent implements DecidingAgent {
  private readonly client: ClaudeClient;
  private readonly difficulty: Difficulty;
  private readonly fallback: DecidingAgent;
  private readonly systemExtra: string | undefined;

  constructor(
    client: ClaudeClient,
    difficulty: Difficulty = 'normal',
    fallback: DecidingAgent = new HeuristicAgent(),
    opts?: { systemExtra?: string },
  ) {
    this.client = client;
    this.difficulty = difficulty;
    this.fallback = fallback;
    this.systemExtra = opts?.systemExtra;
  }

  async decide(
    state: GameState,
    player: PlayerIndex,
    legal: Action[],
  ): Promise<Decision> {
    if (legal.length === 0) {
      throw new Error('LLMAgent.decide: no legal actions');
    }
    const cfg = DIFFICULTY[this.difficulty];
    const candidates = prescreen(state, player, legal, cfg.topK);
    const described = candidates.map((action) => ({
      action,
      description: describeAction(state, player, action),
    }));
    const { system, user } = buildDecisionPrompt(state, player, described);
    // systemExtra（bench 策略变体注入缝）拼在静态 system 尾部——前缀不变，
    // 缓存友好；生产不注入（undefined 时逐字节同 buildDecisionPrompt 输出）。
    const fullSystem =
      this.systemExtra !== undefined ? `${system}\n${this.systemExtra}` : system;
    const fullUser =
      this.difficulty === 'hard' ? user + lookaheadSection(state) : user;

    const baseReq = {
      system: fullSystem,
      candidates: candidates.length,
      // BRASS_AI_MODEL 覆盖难度默认模型（网关不提供默认模型名时用——如本地网关
      // 只有 DeepSeek-V4-Flash 没有 claude-sonnet-4-5）。
      model: process.env['BRASS_AI_MODEL'] ?? cfg.model,
      maxTokens: cfg.maxTokens,
      // 网关慢时 8s 频繁超时→降级启发式（v5-ab 实测 15% 超时）。BRASS_AI_TIMEOUT_MS
      // 覆盖难度默认超时，慢网关调到 30s+，减少误降级。
      timeoutMs: Number(process.env['BRASS_AI_TIMEOUT_MS'] ?? cfg.timeoutMs),
    };
    const usage = { input: 0, output: 0 };

    try {
      const first = await this.client.decide({ ...baseReq, user: fullUser });
      usage.input += first.usage.input;
      usage.output += first.usage.output;
      if (isValid(first.choiceIndex, candidates.length)) {
        return {
          action: candidates[first.choiceIndex]!,
          reason: first.reason,
          degraded: false,
          usage,
        };
      }
      const why = invalidReason(first.choiceIndex, candidates.length);
      const retryUser =
        `${fullUser}\n\n上次回复无效：${why}。` +
        `请重新选择，choiceIndex 须在 0 到 ${candidates.length - 1} 之间（含两端）。`;
      const second = await this.client.decide({ ...baseReq, user: retryUser });
      usage.input += second.usage.input;
      usage.output += second.usage.output;
      if (isValid(second.choiceIndex, candidates.length)) {
        return {
          action: candidates[second.choiceIndex]!,
          reason: second.reason,
          degraded: false,
          usage,
        };
      }
      return this.degrade(
        state,
        player,
        legal,
        `重试仍无效：${invalidReason(second.choiceIndex, candidates.length)}`,
        usage,
      );
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      return this.degrade(state, player, legal, `API 异常：${cause}`, usage);
    }
  }

  /** 降级路径：HeuristicAgent Top-1，reason 记录降级原因，usage 为已消耗 token。 */
  private async degrade(
    state: GameState,
    player: PlayerIndex,
    legal: Action[],
    cause: string,
    usage: { input: number; output: number },
  ): Promise<Decision> {
    const d = await this.fallback.decide(state, player, legal);
    return {
      action: d.action,
      reason: `LLM 决策降级（${cause}）；${d.reason}`,
      degraded: true,
      usage,
    };
  }
}
