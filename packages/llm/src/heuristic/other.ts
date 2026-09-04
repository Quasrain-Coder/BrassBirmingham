/**
 * DEVELOP / SELL / LOAN / SCOUT / PASS 评分。
 * 移植自 brass-assistant heuristic_ai/{develop,sell,loan,scout_pass}.rs。
 */
import {
  MERCHANTS,
  applySell,
  buyIronCost,
  incomeLevelAt,
  ironSources,
  type Action,
  type GameState,
  type IndustryType,
  type MerchantId,
  type PlayerIndex,
  type TileDef,
} from '@brass/engine';
import { scoreBuild } from './build.js';
import {
  eraProgress,
  roundsRemaining,
  vpEquivalent,
  type EvalContext,
} from './context.js';

const LOAN_AMOUNT = 30;
const LOAN_INCOME_PENALTY = 3;

/** 硬战略护栏（brass-assistant 同款）：不研发 2 级+铁厂；运河时代不研发 2 级+酒厂。 */
const BAN_DEVELOP_IRON_LV2_PLUS = true;
const BAN_DEVELOP_BREWERY_LV2_PLUS_AT_CANAL_EARLY = true;

/** 研发移除 2 级+煤/酒厂的机会成本惩罚（板块本身还有建造成效）。 */
function developGuardrailPenalty(ind: IndustryType, level: number): number {
  if (level < 2) return 0;
  if (ind === 'brewery') return 1.8 + 0.2 * (level - 2);
  if (ind === 'coal') return 1.5 + 0.2 * (level - 2);
  return 0;
}

function hasBuildableCard(
  state: GameState,
  pid: PlayerIndex,
  ind: IndustryType,
): boolean {
  return state.players[pid]!.hand.some(
    (c) =>
      (c.kind === 'industry' && c.industries.includes(ind)) ||
      c.kind === 'wild-industry',
  );
}

/** 单个研发目标的价值（removed = 被移除的栈顶板块；unlocked = 露出的下一级）。 */
function developTargetValue(
  state: GameState,
  pid: PlayerIndex,
  ind: IndustryType,
  removed: TileDef,
  unlocked: TileDef | undefined,
  ctx: EvalContext,
): number {
  let v = removed.railEraBuildable ? 0.35 : 0.12;
  v += 0.18 * removed.level;
  if (unlocked?.railEraBuildable) v += 0.25;
  // 酒厂是经济引擎（研发 1 级 → 建 2/3/4 级）。运河早期低价铁时几乎必做；
  // 铁贵（£3+）时铁该留着建造/供铁。
  if (ind === 'brewery' && removed.level === 1) {
    v += 0.55;
    if (ctx.profile.phase === 'canal-early') {
      const freeIron = ironSources(state).reduce(
        (s, x) => s + x.tile.resources,
        0,
      );
      const ironPrice = freeIron > 0 ? 0 : buyIronCost(state, 1);
      if (ironPrice < 2) v += 3.0;
      else if (ironPrice <= 2) v += 2.0;
      else if (ironPrice <= 3) v += 0.5;
      else v -= 1.5;
    }
  }
  if (state.era === 'canal') v += 0.15;
  if (ctx.plan.industry === ind) v += 0.3;
  if (hasBuildableCard(state, pid, ind)) v += 0.3;
  return v - developGuardrailPenalty(ind, removed.level);
}

/** develop 行动评分（对应 score_develop_plan）。 */
export function scoreDevelop(
  state: GameState,
  pid: PlayerIndex,
  action: Extract<Action, { type: 'develop' }>,
  ctx: EvalContext,
): number {
  const ps = state.players[pid]!;
  if (action.removals.length === 0) return Number.NEGATIVE_INFINITY;

  // 铁源与成本：免费铁厂方块优先，不足按市价。
  const freeIron = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
  const ironNeeded = action.removals.length;
  const ironBuy = Math.max(0, ironNeeded - freeIron);
  const ironCost = ironBuy > 0 ? buyIronCost(state, ironBuy) : 0;
  if (ironCost > ps.money) return Number.NEGATIVE_INFINITY;

  // 逐次移除求值（同产业第二次移除针对下一级板块）
  const seen = new Map<IndustryType, number>();
  const values: number[] = [];
  for (const ind of action.removals) {
    const offset = seen.get(ind) ?? 0;
    seen.set(ind, offset + 1);
    const stack = ps.tiles.filter((t) => t.industry === ind);
    const removed = stack[offset];
    if (!removed || !removed.developable) return Number.NEGATIVE_INFINITY;
    if (BAN_DEVELOP_IRON_LV2_PLUS && ind === 'iron' && removed.level >= 2) {
      return Number.NEGATIVE_INFINITY;
    }
    if (
      BAN_DEVELOP_BREWERY_LV2_PLUS_AT_CANAL_EARLY &&
      state.era === 'canal' &&
      ind === 'brewery' &&
      removed.level >= 2
    ) {
      return Number.NEGATIVE_INFINITY;
    }
    values.push(
      developTargetValue(state, pid, ind, removed, stack[offset + 1], ctx),
    );
  }

  const first = values[0]!;
  const secondValue = values.length > 1 ? values[1]! * 0.4 : 0;
  // 铁稀缺且研发耗一整动：非免费铁要收真实机会成本。
  const ironScarcity = ironBuy > 0 ? 0.6 : 0;

  let score =
    vpEquivalent(ctx.profile, first + secondValue, 0, -ironCost, 0) -
    ironScarcity;
  if (state.era === 'canal') {
    score *= 2;
    // 运河时代单块研发通常节奏低效；双块研发优先。
    score += values.length > 1 ? 0.5 : -2.0;
  }
  // （brass-assistant 的研发次数护栏依赖引擎追踪 develops_in_canal/rail，
  //  本引擎状态无此字段，略去；2-ply 前瞻会自然抑制无脑连研发。）
  return score;
}

// ---------------------------------------------------------------------------
// SELL
// ---------------------------------------------------------------------------

/** 商人奖励折算（vp / income 格 / £ / 免费研发）。 */
function merchantBonusValue(id: MerchantId, ctx: EvalContext): number {
  const bonus = MERCHANTS[id].bonus;
  switch (bonus.type) {
    case 'vp':
      return bonus.amount;
    case 'money':
      return bonus.amount * ctx.profile.moneyW;
    case 'income':
      return bonus.amount * ctx.profile.incomeW;
    case 'develop':
      return 0.5;
  }
}

function ownBreweryStats(
  state: GameState,
  pid: PlayerIndex,
): { barrels: number; flipped: number } {
  let barrels = 0;
  let flipped = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && t.tile.industry === 'brewery') {
        if (!t.flipped) barrels += t.resources;
        else flipped += 1;
      }
    }
  }
  return { barrels, flipped };
}

/** sell 行动评分（对应 score_sell_plan 的分值部分；目标组合已由引擎枚举给出）。 */
export function scoreSell(
  state: GameState,
  pid: PlayerIndex,
  action: Extract<Action, { type: 'sell' }>,
  ctx: EvalContext,
): number {
  let totalVp = 0;
  let totalIncome = 0;
  let totalBonus = 0;
  for (const sale of action.sales) {
    const placed = state.board.slots[sale.location]?.[sale.slotIndex];
    if (!placed || placed.player !== pid || placed.flipped) {
      return Number.NEGATIVE_INFINITY;
    }
    totalVp += placed.tile.vp + placed.tile.incomeAdvance * 0.3;
    totalIncome += placed.tile.incomeAdvance;
    if (sale.useMerchantBeer) totalBonus += merchantBonusValue(sale.merchant, ctx);
  }
  if (action.sales.length === 0) return Number.NEGATIVE_INFINITY;

  // 时代末紧迫性：运河末轮 1 级可售板块不翻就永久消失；铁路末卖货即收官。
  const roundsLeft = roundsRemaining(state);
  const urgent =
    (state.era === 'canal' && roundsLeft <= 2) ||
    (state.era === 'rail' && roundsLeft <= 1);
  let urgencyBonus = urgent ? 3.0 : 0;
  if (ctx.profile.phase === 'rail-late' && !urgent) urgencyBonus += 1.2;

  // 运河末战术：把酒喝空、让酒厂翻面（否则桶随时代消失）。
  let canalBeerDrainBonus = 0;
  if (state.era === 'canal' && roundsLeft <= 2.5) {
    const before = ownBreweryStats(state, pid);
    try {
      const r = applySell(state, pid, action);
      const after = ownBreweryStats(r.state, pid);
      const consumed = Math.max(0, before.barrels - after.barrels);
      const flippedGain = Math.max(0, after.flipped - before.flipped);
      canalBeerDrainBonus = consumed * 0.9 + flippedGain * 2.2;
      if (before.barrels > 0 && after.barrels === 0) canalBeerDrainBonus += 3.8;
    } catch {
      canalBeerDrainBonus = 0;
    }
  }

  // 翻面推进收入 = 持续性现金流，显式加计。
  const incomeStream = totalIncome * ctx.profile.incomeW * 0.5;

  // 运河早期卖货折现：早期更该把钱/动作投在经济引擎上。
  const base = vpEquivalent(ctx.profile, totalVp, totalIncome, 0, 0);
  const progress = eraProgress(state);
  const vpScore =
    state.era === 'rail'
      ? base
      : progress < 0.375
        ? base * 0.3
        : progress < 0.75
          ? base * 0.6
          : base;

  return vpScore + totalBonus + urgencyBonus + incomeStream + canalBeerDrainBonus;
}

// ---------------------------------------------------------------------------
// LOAN
// ---------------------------------------------------------------------------

/** 预算内可负担的最佳建造分（loan 的"贷后解锁"估算；预算外候选不参与）。 */
function bestAffordableBuildScore(
  state: GameState,
  pid: PlayerIndex,
  budget: number,
  ctx: EvalContext,
): number {
  let best = 0;
  for (const t of ctx.targets) {
    const s = scoreBuild(
      state,
      pid,
      { type: 'build', cardId: '', industry: t.industry, location: t.location },
      ctx,
      budget,
    );
    if (s > best) best = s;
  }
  return best;
}

/** loan 行动评分（对应 score_loan_result，另含 prescreen 排名用的显式 combo 项）。 */
export function scoreLoan(
  state: GameState,
  pid: PlayerIndex,
  ctx: EvalContext,
): number {
  const ps = state.players[pid]!;
  const incomeLevel = incomeLevelAt(ps.incomeSpace);
  const cash = ps.money;

  // 健康收入位的贷款是自我清偿的（贷后收入 ≥3 时损失可在剩余轮次内赚回，
  // ≥6 近乎无感）——赢家在收入 5→2/9→6/21→18 位高频贷款转 VP（第 1 轮
  // GLM vs 0903 复盘：此类贷款 118 次被旧评分排到 rank>20，LLM 看不见）。
  const postLoanIncomeRaw = incomeLevel - LOAN_INCOME_PENALTY;
  const incomeCostEff =
    postLoanIncomeRaw >= 6
      ? 0
      : postLoanIncomeRaw >= 3
        ? LOAN_INCOME_PENALTY * ctx.profile.incomeW * 0.25
        : LOAN_INCOME_PENALTY * ctx.profile.incomeW;

  // 贷后预算解锁的最佳建造增量
  const after = bestAffordableBuildScore(state, pid, cash + LOAN_AMOUNT, ctx);
  const now = bestAffordableBuildScore(state, pid, cash, ctx);
  const gain = Math.max(0, after - now);

  // 同回合 combo：prescreen 排名没有前瞻（HeuristicAgent.pick 的 2-ply 不参与
  // 排名），贷款必须显式记「贷后本回合还能做的最佳正分行动」——heuristic-core
  // scoreLoanOp 的 comboScale 同款，否则贷款候选结构性落后于单次建造。
  const comboBonus =
    cash < 24 && roundsRemaining(state) > 1.5 ? Math.max(0, after) * 0.7 : 0;

  // 终局增益修正：收官阶段现金本来花不完（现金终局无价值），贷款的真实增益
  // 是「凭空多做一件可负担的建设」，按贷后可负担最佳建造分折算（×0.7 防过
  // 调），而非与当前预算的差值——现金充裕时差值恒 0，造成结构性低估。
  const endgame = roundsRemaining(state) <= 2;
  const gainEff = endgame && after > 0 ? Math.max(gain, after * 0.7) : gain;

  // 闲置保护：手上的钱什么正事都干不了时就借
  const idleBonus = cash < 18 ? 2.0 : 0;

  // 收入地板：绝不借进深度负收入（破产螺旋）
  const floorPenalty =
    postLoanIncomeRaw <= -7 ? 7.0 : postLoanIncomeRaw <= -4 ? 2.0 : postLoanIncomeRaw <= 0 ? 0.3 : 0;

  // 现金充裕不滥借；但健康收入位（贷后 ≥3）减档、≥6 近乎豁免——终局收入不折
  // VP，赢家惯用「贷款→当场翻面」把现金转成 VP（第 1 轮 GLM vs 0903 复盘：
  // bot 实际选择的贷款里 118 次被本评分排到 rank>20，收入 5→2/9→6/21→18 全中）。
  let richPenalty = cash >= 55 ? 5.0 : cash >= 42 ? 2.4 : cash >= 30 ? 1.0 : 0;
  if (richPenalty > 0 && postLoanIncomeRaw >= 6) richPenalty *= 0.3;
  else if (richPenalty > 0 && postLoanIncomeRaw >= 3) richPenalty *= 0.6;

  const unlockBonus = now <= 0 && after > 0.8 ? 3.2 : 0;

  // 创业贷款峰值：运河早期头一两轮低现金 —— 贷款养活经济引擎
  const startupLoanBonus =
    ctx.profile.phase === 'canal-early' && eraProgress(state) < 0.25
      ? cash < 18
        ? 6.0
        : 0.5
      : 0;

  // 运河末贷款：借铁路时代启动资金（-3 收入可靠随后卖货快速收复）
  let canalLateLoanBonus = 0;
  if (ctx.profile.phase === 'canal-late' && eraProgress(state) >= 0.6) {
    const canFlipSoon = Object.values(state.board.slots).some((slots) =>
      slots.some(
        (t) => t && t.player === pid && !t.flipped && t.tile.sellable,
      ),
    );
    if (canFlipSoon && cash < 30) canalLateLoanBonus = cash < 18 ? 2.8 : 1.8;
  }

  return (
    gainEff +
    comboBonus +
    idleBonus +
    unlockBonus +
    startupLoanBonus +
    canalLateLoanBonus -
    incomeCostEff -
    floorPenalty -
    richPenalty
  );
}

// ---------------------------------------------------------------------------
// SCOUT / PASS
// ---------------------------------------------------------------------------

const LOW_KEEP_SCORE = 1.0;
const HIGH_KEEP_SCORE = 1.8;
const DESIRED_HIGH_VALUE_CARDS = 2;
const MAX_HAND_REFRESH_SCORE = 1.92;

/** 搜寻后保留手牌的"急需换新"程度（scout_pass.rs scout_hand_refresh_score）。 */
function handRefreshScore(retainedKeeps: number[]): number {
  if (retainedKeeps.length === 0) return 0;
  const n = retainedKeeps.length;
  const lowRatio =
    retainedKeeps.filter((s) => s <= LOW_KEEP_SCORE).length / n;
  const highCount = retainedKeeps.filter((s) => s >= HIGH_KEEP_SCORE).length;
  const highShortfall = Math.min(
    1,
    Math.max(0, (DESIRED_HIGH_VALUE_CARDS - highCount) / DESIRED_HIGH_VALUE_CARDS),
  );
  const avg = retainedKeeps.reduce((s, x) => s + x, 0) / n;
  const avgShortfall = Math.min(1, Math.max(0, (1.15 - avg) / 1.15));
  return (
    MAX_HAND_REFRESH_SCORE *
    lowRatio *
    (0.35 + 0.65 * highShortfall) *
    avgShortfall
  );
}

/** scout 行动评分：按实际弃掉的 3 张卡的保留价值 + 保留手牌的新增需求。 */
export function scoreScout(
  state: GameState,
  pid: PlayerIndex,
  action: Extract<Action, { type: 'scout' }>,
  ctx: EvalContext,
): number {
  const discarded = action.cardIds.map(
    (id) => ctx.cardKeepById.get(id) ?? 0,
  );
  if (discarded.length !== 3) return Number.NEGATIVE_INFINITY;
  const deadCount = discarded.filter((s) => s <= 0).length;
  const discardScore = deadCount * 0.96 - (3 - deadCount) * 0.48;

  const discardedIds = new Set(action.cardIds);
  const retained = state.players[pid]!.hand
    .filter((c) => !discardedIds.has(c.id))
    .map((c) => ctx.cardKeepById.get(c.id) ?? 0);
  return discardScore + handRefreshScore(retained);
}

/** pass 固定低分：弃一张卡什么都不做，几乎总比任何真实行动差。 */
export const PASS_SCORE = -5;
