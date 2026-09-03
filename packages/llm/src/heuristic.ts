/**
 * 启发式行动评估器（HeuristicAgent）——LLM 预筛、降级兜底、复盘锚点三用。
 *
 * 评分内核移植自 brass-assistant（github.com/Eluvk/brass-assistant）的 Rust
 * heuristic_ai（其本身译自 npow-brass-birmingham 的 aiPlayer.js 并经长期调参）：
 * - 时代相位权重（context.ts eraProfile）：运河重收入/现金流，铁路早重网络，
 *   铁路末收入权重归零、现金贬值——所有评分统一折算成 VP 等值。
 * - 生产计划（context.ts computePlan）：按版面容量/剩余板块/手牌支持/啤酒保障
 *   选出目标可售产业（"流派"），建造与铺路评分向其对齐。
 * - 手牌保留价值（context.ts cardKeepScore）：每个行动扣减所弃卡的保留价值
 *   （wild 昂贵、重复卡贬值、城满地点卡贬值），弃牌选择自然最优。
 * - build：市场饥渴度、孤岛煤矿惩罚、翻面概率、啤酒经济、免费搭车比率
 *   （build.ts）；network：枢纽 VP 潜力、过度铺路惩罚、运河末关键路径、
 *   双轨协同（network.ts）；develop/sell/loan/scout 见 other.ts。
 * - HeuristicAgent.pick 在评分之上做确定性 2-ply 同回合前瞻
 *   （lookahead：首动 Top3 × 次动 Top2 + 回合末现金惩罚），对应
 *   brass-assistant heuristic_ai/lookahead.rs 的 choose_action。
 *
 * scoreAction 仍为纯函数快评（不仿真），供 prescreen/复盘对齐使用；
 * 规则数值一律走 @brass/engine 的 market/network helpers，本包不重复实现规则。
 */
import {
  applyAction,
  enumerateActions,
  incomeLevelAt,
  stableStringify,
  type Action,
  type GameState,
  type PlayerAgent,
  type PlayerIndex,
} from '@brass/engine';
import type { DecidingAgent, Decision } from './decision.js';
import { scoreBuild } from './heuristic/build.js';
import {
  CARD_KEEP_WEIGHT,
  FLEX_WEIGHT,
  getContext,
  roundsRemaining,
} from './heuristic/context.js';
import { scoreNetwork } from './heuristic/network.js';
import {
  PASS_SCORE,
  scoreDevelop,
  scoreLoan,
  scoreScout,
  scoreSell,
} from './heuristic/other.js';

/** 评分权重（导出便于调参/复盘对齐；各子模块内部还有局部常量）。 */
export const HEURISTIC_WEIGHTS = {
  /** 行动分中扣减所弃手牌保留价值的权重。 */
  cardKeep: CARD_KEEP_WEIGHT,
  /** 手牌灵活性在局面评估中的权重。 */
  flex: FLEX_WEIGHT,
  /**
   * pass：显著为负——pass 弃一张卡且什么也不做，几乎总比任何真实行动差。
   * 对 LLM 候选排名，pass 必须明显排在所有真实行动之后。
   */
  pass: PASS_SCORE,
} as const;

/** 纯函数快评：分数越高越优；并列由调用方按数组序裁决。 */
export function scoreAction(
  state: GameState,
  player: PlayerIndex,
  action: Action,
): number {
  const ctx = getContext(state, player);
  let score: number;
  switch (action.type) {
    case 'build':
      score = scoreBuild(state, player, action, ctx);
      break;
    case 'network':
      score = scoreNetwork(state, player, action, ctx);
      break;
    case 'sell':
      score = scoreSell(state, player, action, ctx);
      break;
    case 'develop':
      score = scoreDevelop(state, player, action, ctx);
      break;
    case 'loan':
      score = scoreLoan(state, player, ctx);
      break;
    case 'scout':
      // scout 的分值已包含所弃 3 卡的保留价值，不再重复扣
      return scoreScout(state, player, action, ctx);
    case 'pass':
      return HEURISTIC_WEIGHTS.pass;
  }
  if (score === Number.NEGATIVE_INFINITY) return score;
  // 弃牌维度：消耗保留价值低的卡（wild 最贵，重复卡/城满地点卡便宜）
  const keep = ctx.cardKeepById.get(action.cardId);
  if (keep !== undefined && Number.isFinite(keep)) {
    score -= keep * HEURISTIC_WEIGHTS.cardKeep;
  }
  return score;
}

/**
 * LLM 候选集预筛：按 scoreAction 降序取 Top k（并列保持原数组序，确定性）。
 * k 超出 legal 长度时返回全部（仍按分排序）。
 *
 * **cardId 去重**：legal 里大量行动仅 cardId 不同——先按"除 cardId 外的行动
 * 签名"去重，每种选择只留最高分代表（scoreAction 含弃牌扣分，代表即最优弃牌）。
 *
 * **深度负贷剔除**：贷款会让收入等级退 3 级；贷后收入 ≤-2 会陷入破产螺旋，
 * 直接移出候选集。轻度负贷（-1）保留——冠军轨迹显示开局 2→-1 贷款当回合
 * 翻酒厂/铁厂转正才是最强打法（2026-09-03 bench：剔除后 LLM 现金枯竭陷入
 * pass 死亡螺旋，人均 28.5 VP vs 启发式 113.3）。
 * **枯竭逃生口**：现金 <£10 且收入 0 时贷款是唯一解锁手段（不贷则永远
 * £0/轮、整局锁死，v4 bench 实测 LLM 单局 0 VP），此时一律放行。
 *
 * **类型配额**：去重/消毒后再为每种行动类型各保留该类最高分 1 个，剩余名额
 * 再按分数填满。k 小于类型数时只保留分数最高的前 k 类。输出恒按分数降序。
 */
export function prescreen(
  state: GameState,
  player: PlayerIndex,
  legal: Action[],
  k: number,
): Action[] {
  // 0. 深度负贷剔除：贷后收入 ≤-2 原则上不进候选；但现金枯竭（<£10）时
  // 贷款是唯一逃生口（不贷=永久锁死），一律放行。
  const ps = state.players[player];
  const curLevel = ps ? incomeLevelAt(ps.incomeSpace) : 0;
  const broke = ps !== undefined && ps.money < 10;
  const filtered = legal.filter((a) => {
    if (a.type !== 'loan') return true;
    return curLevel - 3 >= -1 || broke;
  });
  // 1. cardId 去重：稳定序列化（去 cardId）为 key，每种选择只留最高分代表。
  const seen = new Set<string>();
  const deduped: { action: Action; index: number; score: number }[] = [];
  for (const { action, index, score } of filtered
    .map((action, index) => ({ action, index, score: scoreAction(state, player, action) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)) {
    const key = stableStringify({ ...action, cardId: undefined });
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ action, index, score });
  }
  // 2. 类型配额：每类先保最高分 1 个，再按分数填满到 k。
  const picked = new Set<(typeof deduped)[number]>();
  const seenKinds = new Set<string>();
  for (const x of deduped) {
    if (!seenKinds.has(x.action.type)) {
      seenKinds.add(x.action.type);
      picked.add(x);
    }
  }
  for (const x of deduped) {
    if (picked.size >= k) break;
    picked.add(x);
  }
  return deduped.filter((x) => picked.has(x)).slice(0, k).map((x) => x.action);
}

const HEURISTIC_REASON =
  'heuristic fallback: highest scoreAction pick (2-ply lookahead)';

// ---------------------------------------------------------------------------
// 2-ply 同回合前瞻（brass-assistant heuristic_ai/lookahead.rs choose_action）
// ---------------------------------------------------------------------------

const FIRST_ACTION_K = 3;
const SECOND_ACTION_K = 2;
const LOW_MONEY_THRESHOLD = 15;
const END_TURN_PENALTY_SCALE = 6.5;

/** 行动签名（剥 cardId/cardIds）：同操作不同弃牌视为同一候选。 */
function operationKey(action: Action): string {
  if (action.type === 'scout') return 'scout';
  return stableStringify({ ...action, cardId: undefined });
}

/** 候选分组键（brass-assistant candidate_actions_k 的 Top-K 粒度按行动域）。 */
function typeKey(action: Action): string {
  if (action.type === 'network') return action.links.length > 1 ? 'network2' : 'network1';
  return action.type;
}

/**
 * 按行动域各取 Top-K（brass-assistant candidate_actions_k 语义：
 * build/network/双轨各 k 个，其余域各取最优，保证前瞻覆盖所有行动类型）。
 */
function topPerType(
  scored: { action: Action; score: number }[],
  k: number,
): { action: Action; score: number }[] {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const out: { action: Action; score: number }[] = [];
  for (const x of scored) {
    const op = operationKey(x.action);
    if (seen.has(op)) continue;
    const tk = typeKey(x.action);
    const n = counts.get(tk) ?? 0;
    // develop/sell/loan/scout/pass 每域只产出一个最优（与 Rust 一致）
    const cap = tk === 'build' || tk === 'network1' || tk === 'network2' ? k : 1;
    if (n >= cap) continue;
    seen.add(op);
    counts.set(tk, n + 1);
    out.push(x);
  }
  return out;
}

/** 回合末现金惩罚：低现金且收入没起来时结束回合是危险的。 */
function endOfTurnPenalty(
  state: GameState,
  pid: PlayerIndex,
  incomeBefore: number,
): number {
  const p = state.players[pid]!;
  if (p.money >= LOW_MONEY_THRESHOLD) return 0;
  const incomeAfter = incomeLevelAt(p.incomeSpace);
  if (incomeAfter - incomeBefore >= 2.5) return 0;
  const scarcity = Math.min(
    1,
    Math.max(0, (LOW_MONEY_THRESHOLD - p.money) / LOW_MONEY_THRESHOLD),
  );
  const incomeTerm = incomeAfter < 0 ? 1.4 : 0.9;
  const runway = Math.min(1, Math.max(0, roundsRemaining(state) / 8));
  const runwayTerm = 0.6 + 0.4 * (1 - runway);
  const eraTerm = state.era === 'rail' ? 1.0 : 0.8;
  return -END_TURN_PENALTY_SCALE * scarcity * incomeTerm * eraTerm * runwayTerm;
}

/** 首动候选 × 次动最优的确定性前瞻，返回最佳首动。 */
function pickWithLookahead(
  state: GameState,
  player: PlayerIndex,
  legal: Action[],
): Action {
  const ctx = getContext(state, player);
  const incomeBefore = incomeLevelAt(state.players[player]!.incomeSpace);

  // 评分 → 按行动域各取 Top-K 首动候选（覆盖所有类型，而非总分前 K）
  const scored = legal
    .map((action, index) => ({ action, index, score: scoreAction(state, player, action) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const firstCandidates = topPerType(scored, FIRST_ACTION_K);

  let best: { action: Action; value: number } | null = null;
  for (const c1 of firstCandidates) {
    let s1: GameState;
    try {
      s1 = applyAction(state, c1.action);
    } catch {
      continue;
    }
    let value = c1.score;
    let endState = s1;
    // 同一玩家继续行动（2 动回合的第 1 动后）→ 评估最佳第 2 动
    if (
      s1.phase !== 'game-over' &&
      s1.turnOrder[s1.currentPlayerIdx] === player
    ) {
      const secondScored = enumerateActions(s1, player)
        .map((action, index) => ({
          action,
          index,
          score: scoreAction(s1, player, action),
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
      const bestSecond = topPerType(secondScored, SECOND_ACTION_K)[0];
      if (bestSecond) {
        value = c1.score + ctx.profile.alpha * Math.max(0, bestSecond.score);
        try {
          endState = applyAction(s1, bestSecond.action);
        } catch {
          endState = s1;
        }
      }
    }
    value += endOfTurnPenalty(endState, player, incomeBefore);
    if (!best || value > best.value) best = { action: c1.action, value };
  }
  return best?.action ?? scored[0]!.action;
}

/**
 * 启发式 AI：chooseAction 做 2-ply 同回合前瞻选最优（scoreAction 为底层评分）；
 * decide 为 async 包装（固定 reason、degraded: true、usage: 0）——
 * 降级模式下与 LLMAgent 同接口（DecidingAgent）。
 */
export class HeuristicAgent implements PlayerAgent, DecidingAgent {
  chooseAction(state: GameState, legal: Action[]): Action {
    if (legal.length === 0) {
      throw new Error('HeuristicAgent.chooseAction: no legal actions');
    }
    // PlayerAgent 接口不带 player 参数：当前玩家 = turnOrder[currentPlayerIdx]
    const player = state.turnOrder[state.currentPlayerIdx];
    if (player === undefined) {
      throw new Error('HeuristicAgent.chooseAction: no current player');
    }
    return this.pick(state, player, legal);
  }

  decide(
    state: GameState,
    player: PlayerIndex,
    legal: Action[],
  ): Promise<Decision> {
    if (legal.length === 0) {
      throw new Error('HeuristicAgent.decide: no legal actions');
    }
    return Promise.resolve({
      action: this.pick(state, player, legal),
      reason: HEURISTIC_REASON,
      degraded: true,
      usage: { input: 0, output: 0 },
    });
  }

  private pick(
    state: GameState,
    player: PlayerIndex,
    legal: Action[],
  ): Action {
    return pickWithLookahead(state, player, legal);
  }
}
