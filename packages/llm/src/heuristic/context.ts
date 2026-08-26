/**
 * 评估上下文：时代相位权重、生产计划（流派）、手牌保留价值、合法建造目标。
 * 移植自 brass-assistant（Rust）engine/src/ai/heuristic_ai.rs 与 plan.rs，
 * 适配本引擎的 GameState/Action 形状。
 *
 * scoreAction 会对同一 (state, player) 连续调用数百次（每个合法行动一次），
 * 这里把"只与局面和玩家有关、与具体行动无关"的计算用 WeakMap 按 GameState
 * 对象记忆化——引擎状态是不可变持久结构，applyAction 产生新对象即自动失效。
 */
import {
  LOCATIONS,
  MERCHANTS,
  buildDeck,
  enumerateBuilds,
  merchantHasUsableBarrel,
  reachableFrom,
  type GameState,
  type IndustryType,
  type LocationId,
  type MerchantId,
  type PlayerIndex,
} from '@brass/engine';

// ---------------------------------------------------------------------------
// 时代相位与权重（plan.rs era_profile）
// ---------------------------------------------------------------------------

export const VP_WEIGHT = 1;
export const BASE_MONEY_WEIGHT = 0.12;
export const BASE_INCOME_WEIGHT = 0.25;
export const FLEX_WEIGHT = 0.8;
/** 行动分里扣减"所弃手牌保留价值"的权重（越低越该弃）。 */
export const CARD_KEEP_WEIGHT = 0.5;

export type Phase = 'canal-early' | 'canal-late' | 'rail-early' | 'rail-late';

export interface EraProfile {
  phase: Phase;
  incomeW: number;
  moneyW: number;
  networkW: number;
  /** 2-ply 前瞻里第二动的折现系数。 */
  alpha: number;
}

/** 本时代剩余卡牌（牌堆 + 全部手牌）：时代进度的唯一可靠来源（本引擎 round 跨时代累计）。 */
export function cardsRemaining(state: GameState): number {
  return (
    state.deck.length + state.players.reduce((s, p) => s + p.hand.length, 0)
  );
}

/** 时代开始时的卡牌总量（wild 不进牌堆；弃牌堆底 = playerCount 张不在循环内）。 */
function eraCardsTotal(state: GameState): number {
  return buildDeck(state.playerCount).length - state.playerCount;
}

/** 时代进度 0..1（已消耗卡牌比例）。 */
export function eraProgress(state: GameState): number {
  const total = eraCardsTotal(state);
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - cardsRemaining(state) / total));
}

/** 估算本时代剩余轮数（每轮每玩家消耗 2 张；运河首轮 1 张的误差可忽略）。 */
export function roundsRemaining(state: GameState): number {
  return cardsRemaining(state) / (2 * state.playerCount);
}

export function eraPhase(state: GameState): Phase {
  const early = eraProgress(state) <= 0.45;
  return state.era === 'canal'
    ? early
      ? 'canal-early'
      : 'canal-late'
    : early
      ? 'rail-early'
      : 'rail-late';
}

export function eraProfile(state: GameState): EraProfile {
  const phase = eraPhase(state);
  const frac = Math.min(1, Math.max(0, roundsRemaining(state) / 8));
  switch (phase) {
    case 'canal-early':
    case 'canal-late':
      return {
        phase,
        incomeW: BASE_INCOME_WEIGHT * (1.8 + 0.6 * frac),
        moneyW: BASE_MONEY_WEIGHT * 0.55,
        networkW: 1.0,
        alpha: 0.6,
      };
    case 'rail-early':
      return {
        phase,
        incomeW: BASE_INCOME_WEIGHT * (1.2 + 0.5 * frac),
        moneyW: BASE_MONEY_WEIGHT * 0.8,
        networkW: 1.6,
        alpha: 0.6,
      };
    case 'rail-late':
      return { phase, incomeW: 0.0, moneyW: 0.2, networkW: 1.4, alpha: 0.35 };
  }
}

/** VP 等值折算：所有行动分的公共货币单位。 */
export function vpEquivalent(
  profile: EraProfile,
  vp: number,
  income: number,
  money: number,
  flex: number,
): number {
  return (
    vp * VP_WEIGHT +
    income * profile.incomeW +
    money * profile.moneyW +
    flex * FLEX_WEIGHT
  );
}

// ---------------------------------------------------------------------------
// 啤酒供应查询（build.rs 的 owned_beer_barrels / sellable_beer_demand 等）
// ---------------------------------------------------------------------------

const MERCHANT_IDS = Object.keys(MERCHANTS) as MerchantId[];

/** 自己未翻面酒厂（含农场）上的啤酒桶总数。 */
export function ownedBeerBarrels(state: GameState, pid: PlayerIndex): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && t.tile.industry === 'brewery' && !t.flipped) {
        n += t.resources;
      }
    }
  }
  return n;
}

/** 自己全部未翻面可售板块翻面所需啤酒总量。 */
export function sellableBeerDemand(state: GameState, pid: PlayerIndex): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && !t.flipped && t.tile.sellable) {
        n += t.tile.beerToFlip;
      }
    }
  }
  return n;
}

/** 商人位是否有收该产业的板块格（精确图标或万能）。 */
export function merchantAccepts(
  state: GameState,
  id: MerchantId,
  ind: IndustryType,
): boolean {
  const m = state.merchants[id];
  return m.tiles.some((t) => t === 'any' || t === ind);
}

/** 商人位是否有"收该产业的板块格"旁的剩桶。 */
export function merchantHasBeerFor(
  state: GameState,
  id: MerchantId,
  ind: IndustryType,
): boolean {
  return merchantHasUsableBarrel(state.merchants[id], ind);
}

/**
 * at 处可用的啤酒桶数量估计：自己未翻面酒厂（全图）+ 连通的对手酒厂 +
 * 连通的商人桶（任意产业格，估计用）。
 */
export function countBeerSources(
  state: GameState,
  at: LocationId | MerchantId,
  pid: PlayerIndex,
): number {
  const reach = reachableFrom(state, [at]);
  let n = 0;
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (const t of slots) {
      if (!t || t.flipped || t.tile.industry !== 'brewery' || t.resources <= 0) {
        continue;
      }
      if (t.player === pid || reach.has(loc)) n += t.resources;
    }
  }
  for (const id of MERCHANT_IDS) {
    if (!reach.has(id)) continue;
    const m = state.merchants[id];
    n += m.barrels.filter((b, i) => b && m.tiles[i] !== 'blank').length;
  }
  return n;
}

/** at 是否连通任一"有桶（不限产业）"的商人位。 */
export function beerBarrelReachable(
  state: GameState,
  at: LocationId | MerchantId,
): boolean {
  const reach = reachableFrom(state, [at]);
  return MERCHANT_IDS.some((id) => {
    if (!reach.has(id)) return false;
    const m = state.merchants[id];
    return m.barrels.some((b, i) => b && m.tiles[i] !== 'blank');
  });
}

// ---------------------------------------------------------------------------
// 生产计划（plan.rs compute_plan）：目标可售产业、可达数量、啤酒需求
// ---------------------------------------------------------------------------

export interface Plan {
  industry: IndustryType;
  count: number;
  beerNeeded: number;
}

const SELLABLE: IndustryType[] = ['cotton', 'manufacturer', 'pottery'];
const CITY_IDS = Object.entries(LOCATIONS)
  .filter(([, def]) => def.region !== 'farm')
  .map(([id]) => id);

/** 版图上各产业的空槽图标数（仅城市）。 */
function vacantBoardSlots(state: GameState): Map<IndustryType, number> {
  const counts = new Map<IndustryType, number>();
  for (const loc of CITY_IDS) {
    const def = LOCATIONS[loc]!;
    const slots = state.board.slots[loc]!;
    for (let i = 0; i < def.slots.length; i++) {
      if (slots[i] !== null && slots[i] !== undefined) continue;
      for (const ind of def.slots[i]!.industries) {
        counts.set(ind, (counts.get(ind) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** 手牌对某产业的建造支持度（0..3）：地点卡（城内有该产业空槽）/产业卡/wild 产业卡。 */
function handSupport(
  state: GameState,
  pid: PlayerIndex,
  ind: IndustryType,
): number {
  let support = 0;
  for (const card of state.players[pid]!.hand) {
    if (card.kind === 'location') {
      const def = LOCATIONS[card.location];
      if (!def || def.region === 'farm') continue;
      const slots = state.board.slots[card.location]!;
      const ok = def.slots.some(
        (s, i) =>
          s.industries.includes(ind) &&
          (slots[i] === null || slots[i] === undefined),
      );
      if (ok) support += 1;
    } else if (card.kind === 'industry') {
      if (card.industries.includes(ind)) support += 1;
    } else if (card.kind === 'wild-industry') {
      support += 1;
    }
  }
  return Math.min(3, support);
}

function planFlipProbability(
  state: GameState,
  pid: PlayerIndex,
  ind: IndustryType,
): number {
  if (!MERCHANT_IDS.some((id) => merchantAccepts(state, id, ind))) return 0.15;
  const beerOk =
    ownedBeerBarrels(state, pid) > 0 ||
    MERCHANT_IDS.some(
      (id) => merchantAccepts(state, id, ind) && merchantHasBeerFor(state, id, ind),
    );
  return beerOk ? 0.7 : 0.3;
}

/** 计算生产计划：版面容量 × 剩余板块 × 手牌支持 × 售卖概率 × 啤酒保障。 */
export function computePlan(state: GameState, pid: PlayerIndex): Plan {
  const slots = vacantBoardSlots(state);
  const fallback: Plan = { industry: 'cotton', count: 0, beerNeeded: 0 };
  let best = fallback;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const ind of SELLABLE) {
    const stack = state.players[pid]!.tiles.filter((t) => t.industry === ind);
    const remaining = stack.length;
    const avail = slots.get(ind) ?? 0;
    if (remaining === 0 || avail === 0) continue;
    const count = Math.min(remaining, avail);
    let vpSum = 0;
    let beers = 0;
    for (const t of stack.slice(0, count)) {
      vpSum += t.vp;
      beers += t.beerToFlip;
    }
    const avgVp = vpSum / count;
    const ownBeer = ownedBeerBarrels(state, pid);
    const beerFactor =
      ownBeer >= beers
        ? 1.0
        : Math.min(1, 0.4 + 0.6 * (ownBeer / Math.max(1, beers)));
    const handFactor = 0.5 + 0.25 * handSupport(state, pid, ind);
    const score =
      count * avgVp * planFlipProbability(state, pid, ind) * beerFactor * handFactor;
    if (score > bestScore) {
      bestScore = score;
      best = { industry: ind, count, beerNeeded: beers };
    }
  }
  return bestScore === Number.NEGATIVE_INFINITY ? fallback : best;
}

// ---------------------------------------------------------------------------
// 手牌保留价值（heuristic_ai.rs card_keep_score）：越低越该弃
// ---------------------------------------------------------------------------

export interface BuildTargetRef {
  industry: IndustryType;
  location: LocationId;
}

/** 当前合法建造目标（industry × location 去重，剥掉 cardId 维度）。 */
export function buildTargetsOf(
  state: GameState,
  pid: PlayerIndex,
): BuildTargetRef[] {
  const seen = new Set<string>();
  const out: BuildTargetRef[] = [];
  for (const a of enumerateBuilds(state, pid)) {
    if (a.type !== 'build') continue;
    const key = `${a.location}|${a.industry}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ industry: a.industry, location: a.location });
  }
  return out;
}

function cityIsFull(state: GameState, loc: LocationId): boolean {
  return (state.board.slots[loc] ?? []).every((t) => t !== null);
}

export function cardKeepScoreWithTargets(
  state: GameState,
  pid: PlayerIndex,
  cardIndex: number,
  targets: BuildTargetRef[],
): number {
  const hand = state.players[pid]!.hand;
  const card = hand[cardIndex];
  if (!card) return Number.POSITIVE_INFINITY;

  let score =
    card.kind === 'location'
      ? 1.15
      : card.kind === 'industry'
        ? 1.0
        : 3.8; // wild 卡故意昂贵

  // 重复卡保留价值递减（产业卡宽泛编组：运河时代同类生产角色也不灵活）
  let dupCount = 0;
  if (card.kind === 'location') {
    dupCount = hand.filter(
      (c) => c.kind === 'location' && c.location === card.location,
    ).length;
  } else if (card.kind === 'industry') {
    dupCount = hand.filter((c) => c.kind === 'industry').length;
  }
  score -= 0.48 * Math.max(0, dupCount - 1);

  if (card.kind === 'location') {
    const loc = card.location;
    const targetCount = targets.filter((t) => t.location === loc).length;
    if (cityIsFull(state, loc)) {
      // 城满：地点卡仍能绕过 network 做自家资源厂改建（铁路时代），
      // 且手里没有对应产业卡/wild 产业卡可替代时才保留。
      const resourceUpgrade =
        state.era === 'rail' &&
        (LOCATIONS[loc]?.slots ?? []).some((_, slot) => {
          const tile = state.board.slots[loc]?.[slot];
          if (
            !tile ||
            tile.player !== pid ||
            (tile.tile.industry !== 'coal' &&
              tile.tile.industry !== 'iron' &&
              tile.tile.industry !== 'brewery')
          ) {
            return false;
          }
          const next = state.players[pid]!.tiles.find(
            (t) => t.industry === tile.tile.industry,
          );
          return (
            next !== undefined &&
            next.level > tile.tile.level &&
            !hand.some(
              (c) =>
                (c.kind === 'industry' &&
                  c.industries.includes(tile.tile.industry)) ||
                c.kind === 'wild-industry',
            )
          );
        });
      score -= resourceUpgrade ? 0.45 : 1.05;
    } else {
      score += Math.min(3, targetCount) * 0.28;
    }
  } else if (card.kind === 'industry') {
    let bestRoleTargets = 0;
    for (const ind of card.industries) {
      bestRoleTargets = Math.max(
        bestRoleTargets,
        targets.filter((t) => t.industry === ind).length,
      );
    }
    score +=
      bestRoleTargets === 0 ? -0.65 : Math.min(3, bestRoleTargets) * 0.22;
    if (state.era === 'canal' && dupCount > 1) score -= 0.22;
  } else {
    // wild：重复时略降（仍昂贵）
    score += 0.35 * Math.max(0, dupCount - 1);
  }
  return score;
}

// ---------------------------------------------------------------------------
// 记忆化上下文
// ---------------------------------------------------------------------------

export interface EvalContext {
  profile: EraProfile;
  plan: Plan;
  targets: BuildTargetRef[];
  /** 手牌按下标的保留价值（低 = 适合弃）。 */
  cardKeep: number[];
  /** cardId → 保留价值。 */
  cardKeepById: Map<string, number>;
}

const CACHE = new WeakMap<GameState, Map<PlayerIndex, EvalContext>>();

export function getContext(state: GameState, pid: PlayerIndex): EvalContext {
  let perPlayer = CACHE.get(state);
  if (!perPlayer) {
    perPlayer = new Map();
    CACHE.set(state, perPlayer);
  }
  const hit = perPlayer.get(pid);
  if (hit) return hit;

  const targets = buildTargetsOf(state, pid);
  const hand = state.players[pid]!.hand;
  const cardKeep = hand.map((_, i) =>
    cardKeepScoreWithTargets(state, pid, i, targets),
  );
  const ctx: EvalContext = {
    profile: eraProfile(state),
    plan: computePlan(state, pid),
    targets,
    cardKeep,
    cardKeepById: new Map(hand.map((c, i) => [c.id, cardKeep[i]!])),
  };
  perPlayer.set(pid, ctx);
  return ctx;
}

/** 行动卡的保留价值扣分；未知 cardId（测试构造等）不扣分。 */
export function cardPenalty(ctx: EvalContext, cardId: string): number {
  const keep = ctx.cardKeepById.get(cardId);
  if (keep === undefined || !Number.isFinite(keep)) return 0;
  return keep * CARD_KEEP_WEIGHT;
}
