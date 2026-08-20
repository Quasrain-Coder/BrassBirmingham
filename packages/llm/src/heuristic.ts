/**
 * 启发式行动评估器（HeuristicAgent）——LLM 预筛、降级兜底、M4 复盘锚点三用。
 *
 * scoreAction 为纯函数快评（无枚举、无仿真），按行动类型给分量分：
 * - build：板块期望收益 (vp×2 + incomeAdvance×3 + linkIcons×1) / 总成本
 *   （£ + 煤铁按当前市价折算，buyCoalCost/buyIronCost；分母 +1 防零成本板块除零）。
 *   煤矿连通商人位时加计市场售卖预期（canBuyCoalFromMarket + marketSellRevenue——
 *   与 applyBuild 的建成即卖判定同一谓词，锚定建造地点而非玩家 network）。
 *   铁路时代按等级加成分子（防比值评分系统性偏好便宜 L1）。
 * - network：新连通地点数×2；新连通商人位+3；铁路时代每条边基础分。
 * - sell：各板块 vp×2 + incomeAdvance×3；用商人桶时按商人板块奖励折算
 *   （vp→×2、income→×3、£5→2.5、develop→+4）。
 * - develop：解锁高级的潜在收益（新栈顶 − 旧栈顶的 vp/收入差）− 铁市价成本。
 * - loan：现金短缺（< loanCashThreshold）+5，否则 −3（退收入的长期代价）。
 * - scout：−1（节奏代价）；pass：0。
 *
 * 权重集中在 HEURISTIC_WEIGHTS（导出，便于调参/复盘对齐）。
 * 规则数值一律走 @brass/engine 的 market/network helpers，本包不重复实现规则。
 */
import {
  COAL_MARKET_PRICES,
  LINKS,
  LINK_EXTRA_ENDPOINTS,
  MERCHANTS,
  buyCoalCost,
  buyIronCost,
  canBuyCoalFromMarket,
  connectedMerchants,
  incomeLevelAt,
  marketSellRevenue,
  playerNetwork,
  stableStringify,
  type Action,
  type GameState,
  type IndustryType,
  type MerchantId,
  type PlayerAgent,
  type PlayerIndex,
  type TileDef,
} from '@brass/engine';
import type { DecidingAgent, Decision } from './decision.js';

/** 评分权重（常量对象导出便于调参；单位除注明外均为"分"）。 */
export const HEURISTIC_WEIGHTS = {
  /** 翻面板块 vp 单价。 */
  vp: 2,
  /** 收入轨前进格单价。 */
  incomeAdvance: 3,
  /** 翻面板块 Link 图标单价。 */
  linkIcons: 1,
  /** 铁路时代按板块等级的分子加成（每级）。 */
  railEraLevelBonus: 10,
  /** 煤矿连通商人位时市场售卖预期 £ 的折算系数。 */
  coalMarketRevenue: 0.5,
  /** network：每个新连通地点。 */
  networkNewLocation: 2,
  /** network：每个新连通商人位。 */
  networkMerchant: 3,
  /** network：铁路时代每条边的基础分。 */
  railEraLinkBase: 2,
  /** sell：商人 £ 奖励折算（£5/2）。 */
  sellMerchantMoney: 2.5,
  /** sell：商人 develop 奖励折算。 */
  sellMerchantDevelop: 4,
  /** loan 判定现金短缺的现金阈值（£，严格小于）。 */
  loanCashThreshold: 5,
  /** loan：现金短缺时。 */
  loanCashShortage: 5,
  /** loan：否则（退收入的长期代价）。 */
  loanOtherwise: -3,
  /** scout：节奏代价。 */
  scout: -1,
  /**
   * pass：显著为负（-5）——pass 弃一张卡且什么也不做，几乎总比任何真实行动差。
   * 旧值 0 让 LLM 在候选里看到"pass 和 build 并列/甚至第一"（贷款消毒后尤甚），
   * 导致 v3 实测 86% pass。对 LLM 候选排名，pass 必须明显排在所有真实行动之后。
   */
  pass: -5,
} as const;

type Weights = typeof HEURISTIC_WEIGHTS;

/** 翻面期望收益（vp/收入/Link 图标加权和）。 */
function tileValue(def: TileDef, w: Weights): number {
  return (
    def.vp * w.vp +
    def.incomeAdvance * w.incomeAdvance +
    def.linkIcons * w.linkIcons
  );
}

/** build 的总成本（£ + 煤铁按当前市价折算）。 */
function buildCost(state: GameState, def: TileDef): number {
  return (
    def.costMoney +
    (def.costCoal > 0 ? buyCoalCost(state, def.costCoal) : 0) +
    (def.costIron > 0 ? buyIronCost(state, def.costIron) : 0)
  );
}

function scoreBuild(
  state: GameState,
  player: PlayerIndex,
  action: Extract<Action, { type: 'build' }>,
): number {
  const w = HEURISTIC_WEIGHTS;
  const def = state.players[player]?.tiles.find(
    (t) => t.industry === action.industry,
  );
  if (!def) return Number.NEGATIVE_INFINITY;
  let numerator = tileValue(def, w);
  if (state.era === 'rail') numerator += def.level * w.railEraLevelBonus;
  // 煤矿连通商人位的市场售卖预期（与 applyBuild 建成即卖同一谓词）
  if (
    def.industry === 'coal' &&
    canBuyCoalFromMarket(state, action.location)
  ) {
    const expected = marketSellRevenue(
      COAL_MARKET_PRICES,
      state.coalMarket,
      def.resourcesPlaced,
    );
    numerator += expected.revenue * w.coalMarketRevenue;
  }
  return numerator / (buildCost(state, def) + 1);
}

function scoreNetwork(
  state: GameState,
  player: PlayerIndex,
  action: Extract<Action, { type: 'network' }>,
): number {
  const w = HEURISTIC_WEIGHTS;
  const net = playerNetwork(state, player);
  const merchants = new Set(connectedMerchants(state, player));
  const counted = new Set<string>();
  let score = state.era === 'rail' ? w.railEraLinkBase * action.links.length : 0;
  for (const idx of action.links) {
    const link = LINKS[idx];
    if (!link) continue;
    for (const e of [link.a, link.b, ...(LINK_EXTRA_ENDPOINTS[idx] ?? [])]) {
      if (net.has(e) || counted.has(e)) continue;
      counted.add(e);
      if (Object.prototype.hasOwnProperty.call(MERCHANTS, e)) {
        if (!merchants.has(e as MerchantId)) score += w.networkMerchant;
      } else {
        score += w.networkNewLocation;
      }
    }
  }
  return score;
}

function scoreSell(
  state: GameState,
  player: PlayerIndex,
  action: Extract<Action, { type: 'sell' }>,
): number {
  const w = HEURISTIC_WEIGHTS;
  let score = 0;
  for (const sale of action.sales) {
    const placed = state.board.slots[sale.location]?.[sale.slotIndex];
    if (!placed || placed.player !== player) continue;
    score +=
      placed.tile.vp * w.vp + placed.tile.incomeAdvance * w.incomeAdvance;
    if (sale.useMerchantBeer) {
      const bonus = MERCHANTS[sale.merchant].bonus;
      switch (bonus.type) {
        case 'vp':
          score += bonus.amount * w.vp;
          break;
        case 'income':
          score += bonus.amount * w.incomeAdvance;
          break;
        case 'money':
          score += w.sellMerchantMoney;
          break;
        case 'develop':
          score += w.sellMerchantDevelop;
          break;
      }
    }
  }
  return score;
}

function scoreDevelop(
  state: GameState,
  player: PlayerIndex,
  action: Extract<Action, { type: 'develop' }>,
): number {
  const ps = state.players[player];
  if (!ps) return Number.NEGATIVE_INFINITY;
  const removed = new Map<IndustryType, number>();
  for (const ind of action.removals) {
    removed.set(ind, (removed.get(ind) ?? 0) + 1);
  }
  let gain = 0;
  for (const [ind, n] of removed) {
    const stack = ps.tiles.filter((t) => t.industry === ind);
    const cur = stack[0];
    const next = stack[n];
    if (cur && next) gain += tileValue(next, HEURISTIC_WEIGHTS) - tileValue(cur, HEURISTIC_WEIGHTS);
  }
  return gain - buyIronCost(state, action.removals.length);
}

/** 纯函数快评：分数越高越优；并列由调用方按数组序裁决。 */
export function scoreAction(
  state: GameState,
  player: PlayerIndex,
  action: Action,
): number {
  switch (action.type) {
    case 'build':
      return scoreBuild(state, player, action);
    case 'network':
      return scoreNetwork(state, player, action);
    case 'sell':
      return scoreSell(state, player, action);
    case 'develop':
      return scoreDevelop(state, player, action);
    case 'loan': {
      const w = HEURISTIC_WEIGHTS;
      const money = state.players[player]?.money ?? 0;
      return money < w.loanCashThreshold ? w.loanCashShortage : w.loanOtherwise;
    }
    case 'scout':
      return HEURISTIC_WEIGHTS.scout;
    case 'pass':
      return HEURISTIC_WEIGHTS.pass;
  }
}

/**
 * LLM 候选集预筛：按 scoreAction 降序取 Top k（并列保持原数组序，确定性）。
 * k 超出 legal 长度时返回全部（仍按分排序）。
 *
 * **cardId 去重**：legal 里大量行动仅 cardId 不同（弃哪张卡是自由选择，
 * 与决策无关）——开局实测 511 个 legal 行动只有 134 个不同选择，pre-topK 里前
 * 15 个全是同一 develop（只差弃牌），模型根本看不见真正多样的选项、还误把
 * 冗余当排序信号。故先按"除 cardId 外的行动签名"去重，每种选择只留最高分代表。
 *
 * **自杀贷款剔除**：贷款会让收入等级退 3 级；贷后收入为负 = 每轮从 VP 扣钱，
 * 是破产螺旋的唯一来源（baseline 实测 LLM 连环贷 0→-3→-6→-9 全靠它）。
 * 这类贷款直接移出候选集——模型不该有机会选它，也不需要为它"拒绝后 pass"。
 * 纯启发式（HeuristicAgent）仍可用贷款（scoreAction 不变），只对 LLM 候选消毒。
 *
 * **类型配额**：去重/消毒后再为每种行动类型（build/network/sell/develop/loan/scout/pass）
 * 各保留该类最高分 1 个，剩余名额再按分数填满。动机：base-llm20 实测 87%
 * 决策 legal 数 > topK，纯分数截断时 build/network 挤满候选，sell/develop
 * 等低频高价值行动根本到不了 LLM 眼前（sell 实测只占 2%）。k 小于类型数
 * 时只保留分数最高的前 k 类。输出恒按分数降序（LLM 看到的编号序）。
 */
export function prescreen(
  state: GameState,
  player: PlayerIndex,
  legal: Action[],
  k: number,
): Action[] {
  // 0. 自杀贷款剔除：贷后收入 < 0 的贷款永不进 LLM 候选。
  const ps = state.players[player];
  const curLevel = ps ? incomeLevelAt(ps.incomeSpace) : 0;
  const filtered = legal.filter((a) => {
    if (a.type !== 'loan') return true;
    return curLevel - 3 >= 0;
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
  'heuristic fallback: highest scoreAction pick (no LLM call)';

/**
 * 启发式 AI：chooseAction 选 scoreAction 最高者（并列取数组序）；
 * decide 为 async 包装（固定 reason、degraded: true、usage: 0）——
 * 降级模式下与 LLMAgent 同接口（DecidingAgent）。
 */
export class HeuristicAgent implements PlayerAgent, DecidingAgent {
  chooseAction(state: GameState, legal: Action[]): Action {
    if (legal.length === 0) {
      throw new Error('HeuristicAgent.chooseAction: no legal actions');
    }
    // PlayerAgent 接口不带 player 参数：当前玩家 = turnOrder[currentPlayerIdx]
    // （与 playGame 的枚举口径一致）。
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
    let best = legal[0]!;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const action of legal) {
      const score = scoreAction(state, player, action);
      if (score > bestScore) {
        bestScore = score;
        best = action;
      }
    }
    return best;
  }
}
