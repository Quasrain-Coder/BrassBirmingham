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
import { HeuristicAgent, prescreen, scoreAction } from './heuristic.js';
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
      `你每轮约有${state.playerCount >= 3 ? '1-2' : '2'}个行动位，「卖出才翻面」等兑现型板块还要额外花 1 个行动位。` +
      `请评估本行动对未来两轮（翻面节奏、连通铺垫、现金流）的影响，` +
      `剩余轮数很少时不要为"下一轮"做铺垫。`,
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

/**
 * 终局候选消毒：本时代最后 1 轮（剩余卡牌 < 一轮耗量）时，从 LLM 候选中
 * 剔除研发/贷款/侦察——它们全是"为未来投资"的行动，终局无法兑现（贷款
 * 的收入损失再也赚不回来，研发解锁的板块没轮次可建）。b 组 A/B 复盘
 * （bench/out/glm-vs0903/b0、b2，2026-09-05）：prompt 禁令会被启发式
 * rank0 候选压制，终局无效动作必须在过滤层兜底；全滤空时保留原候选。
 */
function endgameFilter(state: GameState, candidates: Action[]): Action[] {
  const cardsLeft =
    state.deck.length + state.players.reduce((sum, p) => sum + p.hand.length, 0);
  const perRound = state.playerCount * actionsPerRound(state);
  if (cardsLeft / perRound > 1) return candidates;
  const filtered = candidates.filter(
    (a) => a.type !== 'develop' && a.type !== 'loan' && a.type !== 'scout',
  );
  return filtered.length > 0 ? filtered : candidates;
}

/**
 * 煤矿配额消毒：场上未翻煤矿满 2 座后从 LLM 候选中剔除「建煤矿」——
 * prompt 配额已被证实无效（c 轮 8/10 局违规、复述规则后仍违反、计数错账），
 * 必须在过滤层兜底。当场翻面的矿建完即翻、不占未翻计数，天然被白名单放行；
 * 剔除后为空（极端局面煤矿是唯一可行）则保留原候选。
 */
function coalQuotaFilter(state: GameState, candidates: Action[]): Action[] {
  const pid = state.turnOrder[state.currentPlayerIdx];
  if (pid === undefined) return candidates;
  let unflippedCoal = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && !t.flipped && t.tile.industry === 'coal') {
        unflippedCoal += 1;
      }
    }
  }
  if (unflippedCoal < 2) return candidates;
  const filtered = candidates.filter(
    (a) => !(a.type === 'build' && a.industry === 'coal'),
  );
  return filtered.length > 0 ? filtered : candidates;
}

/**
 * LLM 决策模式（BRASS_AI_LLM_MODE，缺省 argmax）：
 * - argmax：跳过 LLM 调用，直接选 prescreen Top-1——2026-09-06 argmax 对照
 *   实验（bench/docs/2026-09-06-argmax-architecture.md、round4 终版）证实
 *   LLM 自由选择在全部 5 个 prompt 变体下劣于信评分排序 −8~−24 VP/局，
 *   默认走 argmax 是确定性 +14VP/局；
 * - llm：真 LLM 决策（预筛 → LLM 选择 → 校验 → 重试一次 → 启发式降级），
 *   供复盘/实验与未来模型升级对比用。
 */
function llmMode(): 'argmax' | 'llm' {
  return process.env['BRASS_AI_LLM_MODE'] === 'llm' ? 'llm' : 'argmax';
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
    if (llmMode() === 'argmax') {
      const top = prescreen(state, player, legal, cfg.topK)[0] ?? legal[0]!;
      return {
        action: top,
        reason: 'argmax: prescreen Top-1（BRASS_AI_LLM_MODE 缺省，LLM 自由选择负增量见 bench/docs/2026-09-06-argmax-architecture.md）',
        degraded: true,
        usage: { input: 0, output: 0 },
      };
    }
    const candidates = coalQuotaFilter(
      state,
      endgameFilter(state, prescreen(state, player, legal, cfg.topK)),
    );
    // BRASS_AI_SHOW_SCORES=1：候选描述附启发式快评分（bench A/B 用）——
    // 让 LLM 对齐数值信号，解决文字 prompt 无法逾越的计算差距。
    const showScores = process.env['BRASS_AI_SHOW_SCORES'] === '1';
    const described = candidates.map((action) => {
      const base = describeAction(state, player, action);
      // 延迟兑现标记（b 组 A/B 复盘：模型把「卖出才翻面/桶耗尽才翻面」当
      // 当场翻面计价，10 局 15+ 次误买——信息本在描述尾部，前置标签强制可见）。
      const tag = base.includes('才翻面') ? '【延迟兑现】' : '';
      return {
        action,
        description:
          `${tag}${base}` +
          (showScores ? `｜快评${scoreAction(state, player, action).toFixed(1)}` : ''),
      };
    });
    const { system, user } = buildDecisionPrompt(state, player, described);
    // systemExtra（bench 策略变体注入缝）拼在静态 system 尾部——前缀不变，
    // 缓存友好；生产不注入（undefined 时逐字节同 buildDecisionPrompt 输出）。
    const fullSystem =
      this.systemExtra !== undefined ? `${system}\n${this.systemExtra}` : system;
    // 前瞻段对 normal 也开放（原 hard 专属）：b 组 A/B 复盘证实 normal 档
    // LLM 感知不到剩余轮数——末位贷款/终局废板块的理由都在规划"下一动作"
    // （bench/out/glm-vs0903/b2 复盘，2026-09-05）。
    const fullUser = user + lookaheadSection(state);

    const baseReq = {
      system: fullSystem,
      candidates: candidates.length,
      // BRASS_AI_MODEL 覆盖难度默认模型（网关不提供默认模型名时用——如本地网关
      // 只有 DeepSeek-V4-Flash 没有 claude-sonnet-4-5）。
      model: process.env['BRASS_AI_MODEL'] ?? cfg.model,
      maxTokens: cfg.maxTokens,
      // BRASS_AI_TIMEOUT_MS 覆盖单请求超时（慢思考模型如 k3 用——默认 8s 对带
      // thinking 的模型太紧，会大面积降级到启发式）。
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
