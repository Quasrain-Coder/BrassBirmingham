/**
 * heuristic-v20260829：启发式 AI——brass-assistant 2026-08-29 重构版
 * （engine/src/ai/heuristic_ai/，15 个 Rust 文件）的单文件 TS 移植。
 *
 * 与上游模块一一对应的分节：
 * - config        → config.rs：全部权重/阈值/开关，数值逐字照抄。
 * - context       → context.rs：EvalContext（相位、per-phase 权重、剩余轮数、
 *                   货币折算、时代谓词）。round/era 进度按本引擎改用卡牌计量
 *                   （本引擎 round 跨时代累计，v1 已验证的映射）。
 * - value         → value.rs：ScoreParts 评分分解（vp/money/income/flex/
 *                   strategic/risk）+ 市场模型（simulate_market_sale /
 *                   market_scarcity / price_heat）+ Link 图标估值。
 * - board         → board.rs：共享盘面查询（商人可达、啤酒可得、孤岛、
 *                   免费搭车比率、自家 overbuild VP 损失……）。
 * - probability   → probability.rs：统一翻面概率模型（资源/酒厂/可售三 regime）。
 * - plan          → plan.rs：四相位 + 生产计划（流派）选择。
 * - cards         → cards.rs：手牌保留价值（card-selection head）。
 * - build/network/develop/sell/loan/scout_pass → 同名 .rs 的各行动评分。
 * - lookahead     → lookahead.rs：确定性 2-ply 同回合前瞻 choose_action。
 *
 * 结构差异（语义忠实、载体不同）：上游 scorer 直接对"目标枚举"（BuildTarget
 * 等）打分并自行组装 ResolvedMove；本插件对 engine enumerateActions 产出的
 * legal Action 逐条打分，操作分不含弃牌维度，同操作不同 cardId 的并列以
 * 保留价值最低者优先——等价于上游"操作/选卡两个策略维度分离"的语义。
 *
 * 有意未移植：evaluate_position / estimate_player_vp（MCTS 叶评估器，插件
 * 契约用不到）、distinct_source_options / SOURCE_VARIANTS（MCTS 候选宽度，
 * 本引擎 legal 已含资源来源变体）。develops_in_canal/rail 计数本引擎状态
 * 无此字段，由插件实例按自身决策追踪（只统计自己的 develop 行动，语义一致）。
 */
import {
  BREWERY_BARRELS,
  COAL_MARKET_PRICES,
  IRON_MARKET_PRICES,
  LINK_EXTRA_ENDPOINTS,
  LINKS,
  LOCATIONS,
  MERCHANTS,
  applyAction,
  buildDeck,
  buyCoalCost,
  buyIronCost,
  canBuyCoalFromMarket,
  coalSources,
  enumerateActions,
  enumerateBuilds,
  incomeLevelAt,
  ironSources,
  merchantHasUsableBarrel,
  marketSellRevenue,
  playerNetwork,
  reachableFrom,
  stableStringify,
  type Action,
  type GameState,
  type IndustryType,
  type LocationId,
  type MerchantId,
  type NetworkNode,
  type PlacedTile,
  type PlayerIndex,
  type TileDef,
} from '@brass/engine';
import type { AgentPlugin } from './contract.js';

// ---------------------------------------------------------------------------
// config.rs — 全部调参权重（数值逐字照抄 HeuristicConfig::default）
// ---------------------------------------------------------------------------

const CFG = {
  value: {
    vp: 1.0,
    moneyBase: 0.12,
    incomeBase: 0.25,
    flex: 0.8,
    ownOverbuildVpLoss: 1.0,
    // unflippedVpShare / leafIncomeScale 属 MCTS 叶评估器，未移植。
  },
  era: {
    canalEarly: { incomeAdd: 1.8, incomeFrac: 0.6, moneyMult: 0.55, networkW: 0.1, alpha: 0.6, endgameRounds: 2.0 },
    canalLate: { incomeAdd: 1.8, incomeFrac: 0.6, moneyMult: 0.55, networkW: 0.1, alpha: 0.6, endgameRounds: 2.0 },
    railEarly: { incomeAdd: 1.2, incomeFrac: 0.5, moneyMult: 0.8, networkW: 1.0, alpha: 0.6, endgameRounds: 1.0 },
    railLate: { incomeAdd: 0.0, incomeFrac: 0.0, moneyMult: 5.0 / 3.0, networkW: 0.85, alpha: 0.35, endgameRounds: 1.0 },
  },
  discount: { floor: 0.3, span: 0.5 },
  flip: {
    floor: 0.05,
    cap: 0.9,
    sellout: 0.9,
    coalDemandCanal: 0.55,
    coalDemandRail: 0.85,
    ironDemandCanal: 0.4,
    ironDemandRail: 0.5,
    scarcityBonus: 0.35,
    islandCoalCanalBase: 0.12,
    islandCoalCanalHeatBonus: 0.18,
    islandCoalCanalCap: 0.4,
    islandCoalCanalPriceBase: 5.0,
    islandCoalCanalPriceSpan: 3.0,
    islandCoalRailBase: 0.6,
    islandCoalRailHeatBonus: 0.25,
    islandCoalRailCap: 0.9,
    islandCoalRailPriceBase: 4.0,
    islandCoalRailPriceSpan: 4.0,
    breweryCanalNoDemand: 0.25,
    brewerySurplus: 0.45,
    brewerySatisfied: 0.7,
    breweryRailDemandBuffer: 1.0,
    sellableBase: 0.12,
    sellableMerchantWithBeer: 0.6,
    sellableMerchantOnly: 0.1,
    sellableNoMerchant: -0.6,
    sellableOpenLink: 0.1,
    handEmptyPenalty: 10.0,
    handOneCardPenalty: 5.0,
    handFewCardsPenalty: 2.0,
    planNoMerchant: 0.15,
    planNoBeer: 0.3,
    planReady: 0.7,
    // ── 以下为插件新增（上游无）："没动数翻面就别造"引导 ──
    /** 可售板块翻面期望打满所需的时代剩余动数（造完还需 sell 动+啤酒余量）。 */
    sellWindowFull: 6.0,
    /** 场上每多一块己方未翻面可售板块（排队等 sell 动/啤酒），新建造的翻面期望衰减系数。 */
    sellQueueDecay: 0.8,
  },
  build: {
    unaffordablePerPound: 0.3,
    linkSelfValueShare: 0.5,
    selfSufficiencyPerCube: 0.15,
    ironScarcityShare: 0.6,
    marketCashBackShare: 0.4,
    marketSelloutBonus: 1.5,
    coalSpikePriceBase: 5.0,
    coalSpikePriceSpan: 3.0,
    coalSpikePerSold: 1.9,
    coalSpikeCanalMult: 1.25,
    scarcityValuePerUnit: 0.6,
    leftoverPerCube: 0.5,
    islandCoalCanalPenalty: -0.5,
    islandCoalRailBase: 1.2,
    islandCoalRailPerCube: 0.25,
    islandIronValue: 1.2,
    expansionPerLink: 0.1,
    railCoalShortage: 3.0,
    railCoalShortagePerLevel: 0.2,
    railCoalShortageCubesBase: 0.7,
    railCoalShortagePerCube: 0.15,
    costEfficiencyCap: 2.0,
    merchantReachableBonus: 0.6,
    beerAvailableBonus: 0.8,
    beerMissingPenalty: -0.3,
    brewerySurplusPenaltyPerBarrel: 0.6,
    brewerySellSupportWithDemand: 0.8,
    brewerySellSupportBase: 0.4,
    railBreweryValue: 2.0,
    freeRidingThreshold: 0.5,
    freeRidingBonus: 0.8,
    planBonus: 0.5,
    railLateBeerBonus: 1.2,
  },
  network: {
    accessPerLocationCard: 0.6,
    accessPerIndustryCard: 0.1,
    merchantBonus: 1.5,
    explorationBase: 1.6,
    explorationPerLink: 0.3,
    planBonus: 0.5,
    beerLockBonus: 1.2,
    doubleTempoRailEarly: 1.2,
    doubleTempoOther: 0.6,
    doubleFarmLockBonus: 0.8,
    doubleSurchargeWeight: 1.0,
  },
  develop: {
    railEraTile: 0.35,
    canalEraTile: 0.12,
    perLevel: 0.18,
    railUnlockBonus: 0.25,
    breweryLv1Bonus: 0.55,
    ironPriceVeryCheapBonus: 3.0,
    ironPriceCheapBonus: 2.0,
    ironPriceMarginalBonus: 0.5,
    ironPriceExpensivePenalty: -1.5,
    canalBonus: 0.15,
    planBonus: 0.3,
    buildableCardBonus: 0.3,
    ironScarcityCost: 0.6,
    secondTargetScale: 0.4,
    canalScale: 2.0,
    canalSingleTargetPenalty: 2.0,
    canalDoubleTargetBonus: 0.5,
    canalCountLimit: 4.0,
    railCountLimit: 1.0,
    overLimitSteepness: 2.0,
  },
  sell: {
    developBonusValue: 0.5,
    // tileIncomeShare 在上游仅用于售卖目标排序（本插件对 engine 枚举的
    // 组合评分，用不到），urgency/baseline/stream/vpScale 如下。
    urgencyBonus: 3.0,
    railLateBaselineBonus: 1.2,
    incomeStreamShare: 0.5,
    vpScaleFloor: 0.1,
    vpScaleSpan: 0.5,
  },
  loan: {
    amount: 30,
    incomePenalty: 3,
    comboCashThreshold: 24.0,
    comboMinRoundsLeft: 1.5,
    comboScale: 0.7,
    idleCashThreshold: 18.0,
    idleBonus: 2.0,
    floorDeepDebtIncome: -7,
    floorDeepDebtPenalty: 7.0,
    floorDebtIncome: -4,
    floorDebtPenalty: 2.0,
    floorBreakevenIncome: 0,
    floorBreakevenPenalty: 0.3,
    richHeavyCash: 55.0,
    richHeavyPenalty: 5.0,
    richModerateCash: 42.0,
    richModeratePenalty: 2.4,
    richLightCash: 30.0,
    richLightPenalty: 1.0,
    unlockMinAfterScore: 0.8,
    unlockBonus: 3.2,
    // startupMaxRound: 2 / canalLateMinRound: 6 是"时代内轮数"，本引擎
    // round 跨时代累计，改用时代进度近似（见 scoreLoan 注释）。
    startupMaxProgress: 0.25,
    startupLowCashThreshold: 18.0,
    startupLowCashBonus: 6.0,
    startupBonus: 0.5,
    canalLateMinProgress: 0.625,
    canalLateCashThreshold: 30.0,
    canalLateLowCashBonus: 2.8,
    canalLateBonus: 1.8,
  },
  scout: {
    lowKeep: 1.0,
    highKeep: 1.8,
    desiredHighValue: 2,
    maxRefresh: 5.0,
    deadDiscardValue: 0.96,
    aliveDiscardPenalty: 0.48,
    passFallbackScore: -0.5,
  },
  cards: {
    locationBase: 1.15,
    industryBase: 1.0,
    wildBase: 3.8,
    duplicatePenalty: 0.48,
    wildDuplicateBonus: 0.35,
    cityFullResourceUpgradePenalty: 0.45,
    cityFullUselessPenalty: 1.05,
    cityTargetBonus: 0.28,
    cityTargetCap: 3,
    industryTargetBonus: 0.22,
    industryTargetCap: 3,
    industryNoTargetPenalty: 0.65,
    canalIndustryDuplicatePenalty: 0.22,
  },
  lookahead: {
    firstActionK: 3,
    secondActionK: 2,
    lowMoneyThreshold: 15,
    endTurnPenaltyScale: 6.5,
    endTurnIncomeExempt: 2.5,
    endTurnNegativeIncomeWeight: 1.4,
    endTurnIncomeWeight: 0.9,
    endTurnRailEraTerm: 1.0,
    endTurnCanalEraTerm: 0.8,
    endTurnRunwayBase: 0.6,
    endTurnRunwaySpan: 0.4,
  },
  guardrails: {
    banBuildLv1Brewery: true,
    banDevelopIronLv2Plus: true,
    banDevelopBreweryLv2Canal: true,
    developBreweryPenaltyBase: 1.8,
    developBreweryPenaltyPerLevel: 0.2,
    developCoalPenaltyBase: 1.5,
    developCoalPenaltyPerLevel: 0.2,
  },
} as const;

/** 一时代轮数（context.rs ERA_ROUNDS，仅用于把"时代剩余"归一到 0..1）。 */
const ERA_ROUNDS = 8.0;

const MERCHANT_IDS = Object.keys(MERCHANTS) as MerchantId[];

function isMerchantNode(x: string): x is MerchantId {
  return Object.prototype.hasOwnProperty.call(MERCHANTS, x);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------------------
// plan.rs — 四相位 + 生产计划（流派）
// ---------------------------------------------------------------------------

type Phase = 'canal-early' | 'canal-late' | 'rail-early' | 'rail-late';

/** 本时代剩余卡牌（牌堆 + 全部手牌）：本引擎时代进度的唯一可靠来源。 */
function cardsRemaining(state: GameState): number {
  return state.deck.length + state.players.reduce((s, p) => s + p.hand.length, 0);
}

/** 时代开始时的卡牌总量（wild 不进牌堆；弃牌堆底 = playerCount 张不在循环内）。 */
function eraCardsTotal(state: GameState): number {
  return buildDeck(state.playerCount).length - state.playerCount;
}

/** 时代进度 0..1（已消耗卡牌比例）。 */
function eraProgress(state: GameState): number {
  const total = eraCardsTotal(state);
  if (total <= 0) return 1;
  return clamp01(1 - cardsRemaining(state) / total);
}

/** 估算本时代剩余轮数（每轮每玩家消耗 2 张；运河首轮 1 张的误差可忽略）。 */
function roundsRemaining(state: GameState): number {
  return cardsRemaining(state) / (2 * state.playerCount);
}

/** 上游按"时代内 round <= 4"分早晚；本引擎 round 跨时代累计，改用时代进度。 */
function eraPhase(state: GameState): Phase {
  const early = eraProgress(state) <= 0.45;
  return state.era === 'canal'
    ? early
      ? 'canal-early'
      : 'canal-late'
    : early
      ? 'rail-early'
      : 'rail-late';
}

interface Plan {
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

/** 手牌对某产业的建造支持度（0..3）。 */
function handSupport(state: GameState, pid: PlayerIndex, ind: IndustryType): number {
  let support = 0;
  for (const card of state.players[pid]!.hand) {
    if (card.kind === 'location') {
      const def = LOCATIONS[card.location];
      if (!def || def.region === 'farm') continue;
      const slots = state.board.slots[card.location]!;
      const ok = def.slots.some(
        (s, i) =>
          s.industries.includes(ind) && (slots[i] === null || slots[i] === undefined),
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

/** 玩家面板栈顶板块（next_tile）。 */
function nextTile(state: GameState, pid: PlayerIndex, ind: IndustryType): TileDef | undefined {
  return state.players[pid]!.tiles.find((t) => t.industry === ind);
}

/** 面板栈内第 off 块（tile_after）。 */
function tileAfter(state: GameState, pid: PlayerIndex, ind: IndustryType, off: number): TileDef | undefined {
  let i = 0;
  for (const t of state.players[pid]!.tiles) {
    if (t.industry !== ind) continue;
    if (i === off) return t;
    i += 1;
  }
  return undefined;
}

/** 计算生产计划：版面容量 × 剩余板块 × 手牌支持 × 售卖概率 × 啤酒保障。 */
function computePlan(state: GameState, ctx: EvalCtx): Plan {
  const slots = vacantBoardSlots(state);
  const fallback: Plan = { industry: 'cotton', count: 0, beerNeeded: 0 };
  let best = fallback;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const ind of SELLABLE) {
    const stack = state.players[ctx.pid]!.tiles.filter((t) => t.industry === ind);
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
    const ownBeer = ownedBeerBarrels(state, ctx.pid);
    const beerFactor =
      ownBeer >= beers ? 1.0 : Math.min(1, 0.4 + 0.6 * (ownBeer / Math.max(1, beers)));
    const handFactor = 0.5 + 0.25 * handSupport(state, ctx.pid, ind);
    const score =
      count * avgVp * planFlipProbability(state, ctx, ind) * beerFactor * handFactor;
    if (score > bestScore) {
      bestScore = score;
      best = { industry: ind, count, beerNeeded: beers };
    }
  }
  return bestScore === Number.NEGATIVE_INFINITY ? fallback : best;
}

// ---------------------------------------------------------------------------
// context.rs — EvalContext（相位权重 + 货币折算 + 时代谓词）
// ---------------------------------------------------------------------------

interface EraProfile {
  phase: Phase;
  incomeW: number;
  moneyW: number;
  networkW: number;
  alpha: number;
  endgameRounds: number;
}

interface EvalCtx {
  pid: PlayerIndex;
  phase: Phase;
  profile: EraProfile;
  roundsRemaining: number;
  eraFrac: number;
  plan: Plan;
  targets: BuildTargetRef[];
  /** 手牌按下标的保留价值（低 = 适合弃）。 */
  cardKeep: number[];
  cardKeepById: Map<string, number>;
}

function eraProfileOf(phase: Phase, eraFrac: number): EraProfile {
  const p =
    phase === 'canal-early'
      ? CFG.era.canalEarly
      : phase === 'canal-late'
        ? CFG.era.canalLate
        : phase === 'rail-early'
          ? CFG.era.railEarly
          : CFG.era.railLate;
  return {
    phase,
    incomeW: CFG.value.incomeBase * (p.incomeAdd + p.incomeFrac * eraFrac),
    moneyW: CFG.value.moneyBase * p.moneyMult,
    networkW: p.networkW,
    alpha: p.alpha,
    endgameRounds: p.endgameRounds,
  };
}

const isCanalPhase = (phase: Phase): boolean =>
  phase === 'canal-early' || phase === 'canal-late';

/** 未来收益折现（future_discount）：时代剩得越多，未来越值钱。 */
function futureDiscount(ctx: EvalCtx): number {
  return CFG.discount.floor + CFG.discount.span * ctx.eraFrac;
}

function isEraEndgame(ctx: EvalCtx): boolean {
  return ctx.roundsRemaining <= ctx.profile.endgameRounds;
}

/** 缓存键里不含 develops（实例追踪、随仿真变化），按 (state,pid) 记忆化。 */
const CTX_CACHE = new WeakMap<GameState, Map<PlayerIndex, EvalCtx>>();

function getCtx(state: GameState, pid: PlayerIndex): EvalCtx {
  let perPlayer = CTX_CACHE.get(state);
  if (!perPlayer) {
    perPlayer = new Map();
    CTX_CACHE.set(state, perPlayer);
  }
  const hit = perPlayer.get(pid);
  if (hit) return hit;

  const phase = eraPhase(state);
  const remain = roundsRemaining(state);
  const eraFrac = clamp01(remain / ERA_ROUNDS);
  const targets = buildTargetsOf(state, pid);
  const hand = state.players[pid]!.hand;
  const cardKeep = hand.map((_, i) => cardKeepScore(state, pid, i, targets));
  const ctx: EvalCtx = {
    pid,
    phase,
    profile: eraProfileOf(phase, eraFrac),
    roundsRemaining: remain,
    eraFrac,
    plan: { industry: 'cotton', count: 0, beerNeeded: 0 },
    targets,
    cardKeep,
    cardKeepById: new Map(hand.map((c, i) => [c.id, cardKeep[i]!])),
  };
  ctx.plan = computePlan(state, ctx);
  perPlayer.set(pid, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// value.rs — ScoreParts 评分货币 + 市场模型 + Link 图标估值
// ---------------------------------------------------------------------------

/** 一个行动的评分分解（经济含义分列；total 是唯一折算点）。 */
interface ScoreParts {
  vp: number;
  money: number;
  income: number;
  flex: number;
  strategic: number;
  risk: number;
}

function parts(init?: Partial<ScoreParts>): ScoreParts {
  return { vp: 0, money: 0, income: 0, flex: 0, strategic: 0, risk: 0, ...init };
}

function addParts(a: ScoreParts, b: ScoreParts): void {
  a.vp += b.vp;
  a.money += b.money;
  a.income += b.income;
  a.flex += b.flex;
  a.strategic += b.strategic;
  a.risk += b.risk;
}

/** ScoreParts::total —— 折算成可比较的 VP 等值。 */
function totalOf(ctx: EvalCtx, p: ScoreParts): number {
  return (
    p.vp * CFG.value.vp +
    p.money * ctx.profile.moneyW +
    p.income * ctx.profile.incomeW +
    p.flex * CFG.value.flex +
    p.strategic +
    p.risk
  );
}

interface MarketSale {
  cash: number;
  sold: number;
  total: number;
  flips: boolean;
}

/** 建成即卖市场仿真（与引擎 applyBuild 同一口径：从最贵空格填起）。 */
function simulateMarketSale(state: GameState, isCoal: boolean, cubes: number): MarketSale {
  const prices = isCoal ? COAL_MARKET_PRICES : IRON_MARKET_PRICES;
  const filled = isCoal ? state.coalMarket : state.ironMarket;
  const { revenue, sold } = marketSellRevenue(prices, filled, cubes);
  return { cash: revenue, sold, total: cubes, flips: sold === cubes && cubes > 0 };
}

/** 市场饥渴度：1 = 市场全空（饥饿），0 = 市场全满。 */
function marketScarcity(state: GameState, isCoal: boolean): number {
  const capacity = isCoal ? COAL_MARKET_PRICES.length : IRON_MARKET_PRICES.length;
  const filled = isCoal ? state.coalMarket : state.ironMarket;
  return clamp01((capacity - filled) / capacity);
}

/** 买价热度窗口 (price - base) / span，截到 0..1。 */
function priceHeat(price: number, base: number, span: number): number {
  return clamp01((price - base) / span);
}

/** 市场买 1 块煤的当前价格（市场空 → 兜底价 £8），上游 coal_price()。 */
function coalPrice(state: GameState): number {
  return buyCoalCost(state, 1);
}

/** 市场买 1 块铁的当前价格（市场空 → 兜底价 £6），上游 iron_price()。 */
function ironPrice(state: GameState): number {
  return buyIronCost(state, 1);
}

/** 节点当前 Link 图标分：商人位 2；城市/农场 = 已翻面板块 linkIcons 和。 */
function linkIconsAt(state: GameState, node: NetworkNode): number {
  if (isMerchantNode(node)) return 2;
  let v = 0;
  for (const t of state.board.slots[node] ?? []) {
    if (t && t.flipped) v += t.tile.linkIcons;
  }
  return v;
}

/** 空节点的未来 Link 图标潜力：农场未建 2；城市每空槽 1（可建酒厂 2）。 */
function futureLinkNodePotential(state: GameState, node: NetworkNode): number {
  if (isMerchantNode(node)) return 0;
  const def = LOCATIONS[node];
  if (!def) return 0;
  const slots = state.board.slots[node] ?? [];
  if (def.region === 'farm') return slots.every((t) => t === null) ? 2 : 0;
  let total = 0;
  for (let i = 0; i < def.slots.length; i++) {
    if (slots[i] !== null && slots[i] !== undefined) continue;
    total += def.slots[i]!.industries.includes('brewery') ? 2 : 1;
  }
  return total;
}

/** (current, future)：新 Link（含 via 农场端点）带来的 Link 图标分。 */
function linkCurrentAndPotentialVps(
  state: GameState,
  linkIndex: number,
): { current: number; future: number } {
  const l = LINKS[linkIndex]!;
  const endpoints: NetworkNode[] = [l.a, l.b, ...(LINK_EXTRA_ENDPOINTS[linkIndex] ?? [])];
  let current = 0;
  let future = 0;
  for (const e of endpoints) {
    current += linkIconsAt(state, e);
    future += futureLinkNodePotential(state, e);
  }
  return { current, future };
}

// ---------------------------------------------------------------------------
// board.rs — 共享盘面查询
// ---------------------------------------------------------------------------

/** 商人位是否收该产业（精确图标或万能）。 */
function merchantAccepts(state: GameState, id: MerchantId, ind: IndustryType): boolean {
  const m = state.merchants[id];
  return m.tiles.some((t) => t === 'any' || t === ind);
}

/** 商人位"收该产业的板块格"旁是否还有桶。 */
function merchantHasBeerFor(state: GameState, id: MerchantId, ind: IndustryType): boolean {
  return merchantHasUsableBarrel(state.merchants[id], ind);
}

/** loc 是否连通任一收该产业的商人位。 */
function merchantReachable(state: GameState, loc: LocationId, ind: IndustryType): boolean {
  const reach = reachableFrom(state, [loc]);
  return MERCHANT_IDS.some((id) => reach.has(id) && merchantAccepts(state, id, ind));
}

/** loc 是否连通任一"有桶（不限产业）"的商人位。 */
function beerBarrelReachable(state: GameState, loc: LocationId): boolean {
  const reach = reachableFrom(state, [loc]);
  return MERCHANT_IDS.some((id) => {
    if (!reach.has(id)) return false;
    const m = state.merchants[id];
    return m.barrels.some((b, i) => b && m.tiles[i] !== 'blank');
  });
}

/**
 * loc 处可用的啤酒桶数量估计：自己未翻面酒厂（全图）+ 连通的对手酒厂 +
 * 连通的商人桶（任意产业格，估计用）。
 */
function countBeerSources(state: GameState, at: LocationId, pid: PlayerIndex): number {
  const reach = reachableFrom(state, [at]);
  let n = 0;
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (const t of slots) {
      if (!t || t.flipped || t.tile.industry !== 'brewery' || t.resources <= 0) continue;
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

/** 是否有足够啤酒支撑 need 桶的售卖。 */
function beerAvailable(state: GameState, loc: LocationId, pid: PlayerIndex, need: number): boolean {
  return countBeerSources(state, loc, pid) >= need || beerBarrelReachable(state, loc);
}

/** 自己未翻面酒厂（含农场）上的啤酒桶总数。 */
function ownedBeerBarrels(state: GameState, pid: PlayerIndex): number {
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

/** 场上己方未翻面可售板块数（排队等 sell 动与啤酒的"库存"）。 */
function ownUnflippedSellables(state: GameState, pid: PlayerIndex): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && !t.flipped && t.tile.sellable) n += 1;
    }
  }
  return n;
}

/** 自己全部未翻面可售板块翻面所需啤酒总量。 */
function sellableBeerDemand(state: GameState, pid: PlayerIndex): number {
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

/** loc 相邻（a/b 端点）未建的本时代连接数。 */
function unbuiltNeighborConnections(state: GameState, loc: LocationId): number {
  let n = 0;
  for (let i = 0; i < LINKS.length; i++) {
    const l = LINKS[i]!;
    if (state.era === 'canal' ? !l.canal : !l.rail) continue;
    if (l.a !== loc && l.b !== loc) continue;
    if (state.board.links.some((bl) => bl.linkIndex === i)) continue;
    n += 1;
  }
  return n;
}

/** 玩家是否拥有触及 loc（a/b 端点）的 Link。 */
function ownsLinkTouching(state: GameState, pid: PlayerIndex, loc: LocationId): boolean {
  return state.board.links.some((bl) => {
    if (bl.player !== pid) return false;
    const l = LINKS[bl.linkIndex]!;
    return l.a === loc || l.b === loc;
  });
}

/** 手里有能建 ind 的产业卡 / wild 产业卡。 */
function hasBuildableCard(state: GameState, pid: PlayerIndex, ind: IndustryType): boolean {
  return state.players[pid]!.hand.some(
    (c) => (c.kind === 'industry' && c.industries.includes(ind)) || c.kind === 'wild-industry',
  );
}

/** 建造所需煤铁中能从版面免费源（任何玩家的矿/铁厂）取到的方块比例。 */
function resourceSourceRatio(
  state: GameState,
  pid: PlayerIndex,
  def: TileDef,
  loc: LocationId,
): number {
  const needed = def.costCoal + def.costIron;
  if (needed <= 0) return 1;
  let free = 0;
  if (def.costCoal > 0) {
    const cubes = coalSources(state, pid, loc).reduce((s, x) => s + x.tile.resources, 0);
    free += Math.min(def.costCoal, cubes);
  }
  if (def.costIron > 0) {
    const cubes = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
    free += Math.min(def.costIron, cubes);
  }
  return clamp01(free / needed);
}

/**
 * 本 build 会覆盖的己方板块（引擎规范化解析：对手 overbuild → 空槽 →
 * 己方 overbuild"同产业、等级严格更低、取最低级"）。返回 null = 不覆盖己方。
 */
function overbuiltOwnTile(
  state: GameState,
  pid: PlayerIndex,
  industry: IndustryType,
  loc: LocationId,
  slotIndex: number | undefined,
  newTile: TileDef,
): PlacedTile | null {
  const slots = state.board.slots[loc] ?? [];
  if (slotIndex !== undefined) {
    const t = slots[slotIndex];
    return t && t.player === pid ? t : null;
  }
  // 还有兼容空槽时引擎不会落到己方 overbuild。
  const defs = LOCATIONS[loc]?.slots ?? [];
  const hasEmptyCompatible = defs.some(
    (s, i) => s.industries.includes(industry) && slots[i] === null,
  );
  if (hasEmptyCompatible) return null;
  let best: PlacedTile | null = null;
  for (const t of slots) {
    if (!t || t.player !== pid) continue;
    if (t.tile.industry !== industry || t.tile.level >= newTile.level) continue;
    if (!best || t.tile.level < best.tile.level) best = t;
  }
  return best;
}

/** 新连通激活的手牌：(新进网地点卡数, 产业卡数)。 */
function handAccessGain(
  state: GameState,
  pid: PlayerIndex,
  a: NetworkNode,
  b: NetworkNode,
): { locCards: number; indCards: number } {
  const net = playerNetwork(state, pid);
  let locCards = 0;
  let indCards = 0;
  for (const card of state.players[pid]!.hand) {
    if (card.kind === 'location') {
      if (!net.has(card.location) && (card.location === a || card.location === b)) {
        locCards += 1;
      }
    } else if (card.kind === 'industry') {
      indCards += 1;
    }
  }
  return { locCards, indCards };
}

// ---------------------------------------------------------------------------
// probability.rs — 统一翻面概率模型
// ---------------------------------------------------------------------------

function flipProbability(
  state: GameState,
  ctx: EvalCtx,
  ind: IndustryType,
  loc: LocationId | null,
): number {
  const w = CFG.flip;
  let base: number;
  if (ind === 'coal' || ind === 'iron') {
    const cubes = nextTile(state, ctx.pid, ind)?.resourcesPlaced ?? 1;
    base = resourceFlip(state, ctx, ind, cubes, loc);
  } else if (ind === 'brewery') {
    // 本引擎 brewery 板块 resourcesPlaced 恒 0，放桶数按时代（BREWERY_BARRELS）。
    base = breweryFlip(state, ctx, BREWERY_BARRELS[state.era]);
  } else {
    base = sellableFlip(state, ctx, ind, loc, state.players[ctx.pid]!.hand.length);
  }
  return Math.min(Math.max(base, w.floor), Math.max(w.cap, w.floor));
}

/** 资源翻面模型：市场饥渴 + 时代需求 + 孤岛煤矿特例。 */
function resourceFlip(
  state: GameState,
  ctx: EvalCtx,
  ind: IndustryType,
  cubes: number,
  loc: LocationId | null,
): number {
  const w = CFG.flip;
  const isCoal = ind === 'coal';
  const scarcity = marketScarcity(state, isCoal);
  // 铁厂随处可卖；煤矿需要连通商人位（版面任一商人位即可，煤卖给市场）。
  const canSell =
    ind === 'iron' ||
    (loc !== null
      ? canBuyCoalFromMarket(state, loc)
      : MERCHANT_IDS.some((id) => state.merchants[id].tiles.length > 0));

  if (isCoal && !canSell) {
    const heatPrice = coalPrice(state);
    if (isCanalPhase(ctx.phase)) {
      const heat = priceHeat(heatPrice, w.islandCoalCanalPriceBase, w.islandCoalCanalPriceSpan);
      return Math.min(w.islandCoalCanalCap, w.islandCoalCanalBase + w.islandCoalCanalHeatBonus * heat);
    }
    const heat = priceHeat(heatPrice, w.islandCoalRailPriceBase, w.islandCoalRailPriceSpan);
    return Math.min(w.islandCoalRailCap, w.islandCoalRailBase + w.islandCoalRailHeatBonus * heat);
  }

  const sale = simulateMarketSale(state, isCoal, cubes);
  if (canSell && sale.flips) return w.sellout;

  const eraDemand = isCoal
    ? isCanalPhase(ctx.phase)
      ? w.coalDemandCanal
      : w.coalDemandRail
    : isCanalPhase(ctx.phase)
      ? w.ironDemandCanal
      : w.ironDemandRail;
  return Math.min(w.cap, eraDemand + w.scarcityBonus * scarcity);
}

/** 酒厂翻面模型：真实啤酒需求 vs 供给（含本厂新桶）。 */
function breweryFlip(state: GameState, ctx: EvalCtx, nextCubes: number): number {
  const w = CFG.flip;
  const demand =
    sellableBeerDemand(state, ctx.pid) + (isCanalPhase(ctx.phase) ? 0 : w.breweryRailDemandBuffer);
  const barrels = ownedBeerBarrels(state, ctx.pid) + nextCubes;
  if (demand <= 0.5 && isCanalPhase(ctx.phase)) return w.breweryCanalNoDemand;
  if (barrels > demand) return w.brewerySurplus;
  return w.brewerySatisfied;
}

/** 可售板块翻面模型：连通收该产业的商人 + 有啤酒 + 手牌不太穷。 */
function sellableFlip(
  state: GameState,
  ctx: EvalCtx,
  ind: IndustryType,
  loc: LocationId | null,
  handLen: number,
): number {
  const w = CFG.flip;
  if (loc === null) {
    // 计划层视角：只看版面级可行性。
    if (!MERCHANT_IDS.some((id) => merchantAccepts(state, id, ind))) return w.planNoMerchant;
    const beerOk =
      ownedBeerBarrels(state, ctx.pid) > 0 ||
      MERCHANT_IDS.some((id) => merchantAccepts(state, id, ind) && merchantHasBeerFor(state, id, ind));
    return beerOk ? w.planReady : w.planNoBeer;
  }

  let b = w.sellableBase;
  if (merchantReachable(state, loc, ind)) {
    // 上游此处恒按 need=1 估（概率粗估）；beer_economy 里才用真实桶数。
    b += beerAvailable(state, loc, ctx.pid, 1) ? w.sellableMerchantWithBeer : w.sellableMerchantOnly;
  } else {
    b += w.sellableNoMerchant;
  }
  if (unbuiltNeighborConnections(state, loc) > 0) b += w.sellableOpenLink;
  if (handLen === 0) b -= w.handEmptyPenalty;
  else if (handLen === 1) b -= w.handOneCardPenalty;
  else if (handLen <= 3) b -= w.handFewCardsPenalty;
  return b;
}

/** 具体建造的翻面概率（build_flip_probability）。 */
function buildFlipProbability(state: GameState, ctx: EvalCtx, ind: IndustryType, loc: LocationId): number {
  return flipProbability(state, ctx, ind, loc);
}

/** 计划产业的翻面概率（plan_flip_probability，版面级视角）。 */
function planFlipProbability(state: GameState, ctx: EvalCtx, ind: IndustryType): number {
  return flipProbability(state, ctx, ind, null);
}

// ---------------------------------------------------------------------------
// cards.rs — 手牌保留价值（card-selection head；低 = 适合弃）
// ---------------------------------------------------------------------------

interface BuildTargetRef {
  industry: IndustryType;
  location: LocationId;
}

/** 当前合法建造目标（industry × location 去重，剥掉 cardId 维度）。 */
function buildTargetsOf(state: GameState, pid: PlayerIndex): BuildTargetRef[] {
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

/** card_keep_score_with：一张手牌的保留价值。 */
function cardKeepScore(
  state: GameState,
  pid: PlayerIndex,
  cardIndex: number,
  targets: BuildTargetRef[],
): number {
  const w = CFG.cards;
  const hand = state.players[pid]!.hand;
  const card = hand[cardIndex];
  if (!card) return Number.POSITIVE_INFINITY;

  let score =
    card.kind === 'location' ? w.locationBase : card.kind === 'industry' ? w.industryBase : w.wildBase;

  // 重复卡保留价值递减（产业卡宽泛编组：同生产角色在运河时代也不灵活）。
  let dupCount = 0;
  if (card.kind === 'location') {
    dupCount = hand.filter((c) => c.kind === 'location' && c.location === card.location).length;
  } else if (card.kind === 'industry') {
    dupCount = hand.filter((c) => c.kind === 'industry').length;
  }
  score -= w.duplicatePenalty * Math.max(0, dupCount - 1);

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
          const next = nextTile(state, pid, tile.tile.industry);
          return (
            next !== undefined &&
            next.level > tile.tile.level &&
            !hand.some(
              (c) =>
                (c.kind === 'industry' && c.industries.includes(tile.tile.industry)) ||
                c.kind === 'wild-industry',
            )
          );
        });
      score -= resourceUpgrade ? w.cityFullResourceUpgradePenalty : w.cityFullUselessPenalty;
    } else {
      score += w.cityTargetBonus * Math.min(w.cityTargetCap, targetCount);
    }
  } else if (card.kind === 'industry') {
    let bestRoleTargets = 0;
    for (const ind of card.industries) {
      bestRoleTargets = Math.max(bestRoleTargets, targets.filter((t) => t.industry === ind).length);
    }
    score +=
      bestRoleTargets === 0
        ? -w.industryNoTargetPenalty
        : w.industryTargetBonus * Math.min(w.industryTargetCap, bestRoleTargets);
    if (state.era === 'canal' && dupCount > 1) score -= w.canalIndustryDuplicatePenalty;
  } else {
    // wild：重复时略降（仍昂贵）。上游此处 duplicate_count 恒 0，奖金实际不触发。
    score += w.wildDuplicateBonus * Math.max(0, dupCount - 1);
  }
  return score;
}

/** 行动所消耗手牌的保留价值（scout 为 3 张之和）。 */
function actionCardKeep(ctx: EvalCtx, action: Action): number {
  if (action.type === 'scout') {
    return action.cardIds.reduce((s, id) => s + (ctx.cardKeepById.get(id) ?? 0), 0);
  }
  return ctx.cardKeepById.get(action.cardId) ?? 0;
}

// ---------------------------------------------------------------------------
// build.rs — BUILD 评分
// ---------------------------------------------------------------------------

interface BuildCost {
  cash: number;
  freeCoal: number;
  freeIron: number;
}

/** 建造成本估计：免费煤（连通矿）/铁（全图）抵扣后按市价补。 */
function buildCostOf(state: GameState, pid: PlayerIndex, def: TileDef, loc: LocationId): BuildCost {
  const freeCoal =
    def.costCoal > 0
      ? Math.min(def.costCoal, coalSources(state, pid, loc).reduce((s, x) => s + x.tile.resources, 0))
      : 0;
  const freeIron =
    def.costIron > 0
      ? Math.min(def.costIron, ironSources(state).reduce((s, x) => s + x.tile.resources, 0))
      : 0;
  const coalBuy = def.costCoal - freeCoal;
  const ironBuy = def.costIron - freeIron;
  const cash =
    def.costMoney + (coalBuy > 0 ? buyCoalCost(state, coalBuy) : 0) + (ironBuy > 0 ? buyIronCost(state, ironBuy) : 0);
  return { cash, freeCoal, freeIron };
}

/** 新煤/铁厂产出方块的市场价值：现金回流 + 尖峰/饥渴战略值 − 存留风险。 */
function marketValue(state: GameState, ctx: EvalCtx, ind: IndustryType, loc: LocationId, cubes: number): ScoreParts {
  const w = CFG.build;
  const isCoal = ind === 'coal';
  // 铁饥渴打折：铁需求平稳、市场回填快，过量产铁有风险。
  const scarcity = marketScarcity(state, isCoal) * (isCoal ? 1.0 : w.ironScarcityShare);

  const marketOk = !isCoal || canBuyCoalFromMarket(state, loc);
  if (!marketOk) {
    const strategic = isCoal
      ? isCanalPhase(ctx.phase)
        ? w.islandCoalCanalPenalty
        : scarcity * (w.islandCoalRailBase + w.islandCoalRailPerCube * cubes)
      : scarcity * w.islandIronValue;
    return parts({ strategic });
  }

  const sale = simulateMarketSale(state, isCoal, cubes);
  const cashBackBonus =
    sale.cash > 0 ? sale.cash * w.marketCashBackShare + (sale.flips ? w.marketSelloutBonus : 0) : 0;
  const coalSpikeBonus =
    isCoal && sale.sold > 0
      ? priceHeat(coalPrice(state), w.coalSpikePriceBase, w.coalSpikePriceSpan) *
        sale.sold *
        w.coalSpikePerSold *
        (isCanalPhase(ctx.phase) ? w.coalSpikeCanalMult : 1.0)
      : 0;
  const scarcityValue = scarcity * (1 + sale.sold) * w.scarcityValuePerUnit;
  // 铁路时代煤被几乎每个行动吃掉，存留不重罚。
  const leftoverPenalty =
    isCoal && !isCanalPhase(ctx.phase) ? 0 : (sale.total - sale.sold) * w.leftoverPerCube;

  return parts({
    money: sale.cash,
    strategic: cashBackBonus + coalSpikeBonus + scarcityValue,
    risk: -leftoverPenalty,
  });
}

/** 啤酒经济：可售板块要商人+酒；酒厂按需求匹配产出。 */
function beerEconomy(state: GameState, ctx: EvalCtx, ind: IndustryType, loc: LocationId, beersToSell: number): ScoreParts {
  const w = CFG.build;
  let strategic = 0;
  const sellable = ind === 'cotton' || ind === 'manufacturer' || ind === 'pottery';
  if (sellable) {
    const hasMerchant = merchantReachable(state, loc, ind);
    if (hasMerchant) strategic += w.merchantReachableBonus;
    if (hasMerchant && beerAvailable(state, loc, ctx.pid, beersToSell)) {
      strategic += w.beerAvailableBonus;
    } else {
      strategic += w.beerMissingPenalty;
    }
  } else if (ind === 'brewery') {
    const tileCubes = BREWERY_BARRELS[state.era];
    const barrels = ownedBeerBarrels(state, ctx.pid) + tileCubes;
    const demand = sellableBeerDemand(state, ctx.pid);
    const surplus = Math.max(0, barrels - demand);
    const sellSupport = demand > 0 ? w.brewerySellSupportWithDemand : w.brewerySellSupportBase;
    strategic +=
      sellSupport +
      (isCanalPhase(ctx.phase) ? 0 : w.railBreweryValue) -
      w.brewerySurplusPenaltyPerBarrel * surplus;
  }
  return parts({ strategic });
}

/** 铁路时代紧急供煤溢价：市场近空时任何合法煤矿都是战略资源。 */
function railCoalShortageBonus(state: GameState, ctx: EvalCtx, ind: IndustryType, level: number, cubes: number): number {
  const w = CFG.build;
  if (ind !== 'coal' || isCanalPhase(ctx.phase)) return 0;
  const shortage = marketScarcity(state, true);
  const levelFactor = 1 + w.railCoalShortagePerLevel * Math.max(0, level - 1);
  const cubesFactor = w.railCoalShortageCubesBase + w.railCoalShortagePerCube * cubes;
  return shortage * levelFactor * cubesFactor * w.railCoalShortage;
}

/** 成本效率：(收入 + VP) / 成本，封顶。 */
function costEfficiency(income: number, vp: number, cost: number): number {
  return cost > 0 ? Math.min(CFG.build.costEfficiencyCap, (income + vp) / cost) : 0;
}

/** score_build_candidate：一个 build 操作（industry × location）的评分。 */
function scoreBuildOp(state: GameState, ctx: EvalCtx, ind: IndustryType, loc: LocationId, slotIndex?: number): number {
  const tile = nextTile(state, ctx.pid, ind);
  if (!tile) return Number.NEGATIVE_INFINITY;
  if (CFG.guardrails.banBuildLv1Brewery && ind === 'brewery' && tile.level === 1) {
    return Number.NEGATIVE_INFINITY;
  }

  const cash = state.players[ctx.pid]!.money;
  const cost = buildCostOf(state, ctx.pid, tile, loc);
  if (cost.cash > cash) {
    // 买不起：重度折价（贷款仍是路径，但不做首选）。
    return -(cost.cash - cash) * CFG.build.unaffordablePerPound;
  }

  const sellableInd = ind === 'cotton' || ind === 'manufacturer' || ind === 'pottery';
  let flipProb = buildFlipProbability(state, ctx, ind, loc);
  if (sellableInd) {
    // "没动数翻面就别造"（插件新增）：可售板块翻面需要造完后还有 sell 动——
    // 时代剩余动数窗口越窄，翻面期望越低；场上排队等翻面的库存越多越贬值。
    const actionsLeft = Math.max(0, ctx.roundsRemaining * 2 - 1);
    flipProb *= clamp01(actionsLeft / CFG.flip.sellWindowFull);
    flipProb *= Math.pow(CFG.flip.sellQueueDecay, ownUnflippedSellables(state, ctx.pid));
  }
  const linkSelfValue = ownsLinkTouching(state, ctx.pid, loc)
    ? tile.linkIcons * flipProb * CFG.build.linkSelfValueShare
    : 0;
  const isResource = ind === 'coal' || ind === 'iron';
  const resourceSelfSufficiency = isResource ? CFG.build.selfSufficiencyPerCube * tile.resourcesPlaced : 0;

  const p = parts({
    vp: tile.vp * flipProb + linkSelfValue,
    income: tile.incomeAdvance * flipProb,
    money: -cost.cash,
    strategic:
      resourceSelfSufficiency +
      CFG.build.expansionPerLink * unbuiltNeighborConnections(state, loc) +
      railCoalShortageBonus(state, ctx, ind, tile.level, tile.resourcesPlaced) +
      costEfficiency(tile.incomeAdvance, tile.vp, cost.cash),
  });

  if (isResource) addParts(p, marketValue(state, ctx, ind, loc, tile.resourcesPlaced));
  addParts(p, beerEconomy(state, ctx, ind, loc, tile.beerToFlip));

  // 免费搭车：建造投入从版面矿/铁厂取（消耗对手方块还帮他们翻面）。
  const ratio = resourceSourceRatio(state, ctx.pid, tile, loc);
  p.strategic += Math.max(0, ratio - CFG.build.freeRidingThreshold) * CFG.build.freeRidingBonus;

  // 覆盖己方板块 = 放弃其时代末 VP。
  const over = overbuiltOwnTile(state, ctx.pid, ind, loc, slotIndex, tile);
  if (over) p.risk -= over.tile.vp * CFG.value.ownOverbuildVpLoss;

  // 计划（流派）软加成：运河早期先搭经济引擎，不急于锁定可售线。
  if (ctx.plan.count > 0 && ctx.plan.industry === ind && ctx.phase !== 'canal-early') {
    p.strategic += CFG.build.planBonus;
  }

  // 铁路末"有酒才建产业"：有酒可卖的收官建造加分。
  const sellable = ind === 'cotton' || ind === 'manufacturer' || ind === 'pottery';
  if (ctx.phase === 'rail-late' && sellable) {
    const beerOk = countBeerSources(state, loc, ctx.pid) > 0 || beerBarrelReachable(state, loc);
    if (beerOk) p.strategic += CFG.build.railLateBeerBonus;
  }

  return totalOf(ctx, p);
}

// ---------------------------------------------------------------------------
// network.rs — NETWORK 评分（单条 / 双轨）
// ---------------------------------------------------------------------------

const CANAL_LINK_COST = 3;
const RAIL_LINK_COST = 5;
const RAIL_DOUBLE_LINK_COST = 15;

/** 该铁路的煤成本估计：连通免费矿 → 0；否则市价 1 块（市场空时兜底 £8）。 */
function estimatedLinkCoalCost(state: GameState, linkIndex: number): number {
  const l = LINKS[linkIndex]!;
  const at = [l.a, l.b, ...(LINK_EXTRA_ENDPOINTS[linkIndex] ?? [])].find(
    (e): e is LocationId => !isMerchantNode(e),
  )!;
  const free = coalSources(state, 0, at).reduce((s, x) => s + x.tile.resources, 0);
  return free >= 1 ? 0 : buyCoalCost(state, 1);
}

/** score_network_candidate：单条连接的 ScoreParts。 */
function scoreNetworkLink(state: GameState, ctx: EvalCtx, linkIndex: number, cost: number): ScoreParts {
  const w = CFG.network;
  const l = LINKS[linkIndex]!;
  const a = l.a;
  const b = l.b;

  const { locCards, indCards } = handAccessGain(state, ctx.pid, a, b);
  const flex = locCards * w.accessPerLocationCard + indCards * w.accessPerIndustryCard;

  const { current, future } = linkCurrentAndPotentialVps(state, linkIndex);
  // 时代权重：Rail-Early 铺的网是所有计分的载体，Link 更值钱；
  // 运河时代 networkW 仅 0.1（config.rs 照抄）。
  const vp = (current + futureDiscount(ctx) * future) * ctx.profile.networkW;

  // 探索先验：本时代头几条进空白区域的连接是溢价。
  const linksBuilt = state.board.links.filter((x) => x.player === ctx.pid).length;
  const exploration = Math.max(0, w.explorationBase - w.explorationPerLink * linksBuilt);

  // 计划（流派）加成：触及"计划产业仍有空槽"的城市 = 打开产能（Canal-Late 起）。
  let planBonus = 0;
  if (
    ctx.plan.count > 0 &&
    ctx.phase !== 'canal-early' &&
    state.players[ctx.pid]!.tiles.some((t) => t.industry === ctx.plan.industry)
  ) {
    for (const e of [a, b]) {
      if (isMerchantNode(e)) continue;
      const def = LOCATIONS[e];
      if (!def || def.region === 'farm') continue;
      const slots = state.board.slots[e]!;
      const ok = def.slots.some(
        (s, i) => s.industries.includes(ctx.plan.industry) && (slots[i] === null || slots[i] === undefined),
      );
      if (ok) {
        planBonus = w.planBonus;
        break;
      }
    }
  }

  // Rail-Early 酒厂农场锁定：农场边锁定啤酒供应。
  const endpoints: NetworkNode[] = [a, b, ...(LINK_EXTRA_ENDPOINTS[linkIndex] ?? [])];
  const beerLock =
    ctx.phase === 'rail-early' && endpoints.some((e) => !isMerchantNode(e) && LOCATIONS[e]?.region === 'farm')
      ? w.beerLockBonus
      : 0;

  const merchantGain = isMerchantNode(a) || isMerchantNode(b) ? w.merchantBonus : 0;

  return parts({
    vp,
    flex,
    money: -cost,
    strategic: merchantGain + exploration + planBonus + beerLock,
  });
}

/** network 行动评分（单条/双条统一）。 */
function scoreNetworkOp(state: GameState, ctx: EvalCtx, action: Extract<Action, { type: 'network' }>): number {
  const links = action.links;
  if (links.length === 0) return Number.NEGATIVE_INFINITY;
  const w = CFG.network;

  if (state.era === 'canal') {
    return totalOf(ctx, scoreNetworkLink(state, ctx, links[0]!, CANAL_LINK_COST));
  }

  if (links.length === 1) {
    const cost = RAIL_LINK_COST + estimatedLinkCoalCost(state, links[0]!);
    return totalOf(ctx, scoreNetworkLink(state, ctx, links[0]!, cost));
  }

  // 双轨：两条单条分和 − 贵出的基价（£15 vs 2×£5，按 money 折算）+ 协同。
  const [i1, i2] = [links[0]!, links[1]!];
  const cost1 = RAIL_LINK_COST + estimatedLinkCoalCost(state, i1);
  const cost2 = RAIL_LINK_COST + estimatedLinkCoalCost(state, i2);
  const s1 = scoreNetworkLink(state, ctx, i1, cost1);
  const s2 = scoreNetworkLink(state, ctx, i2, cost2);
  const surcharge = (RAIL_DOUBLE_LINK_COST - 2 * RAIL_LINK_COST) * w.doubleSurchargeWeight * ctx.profile.moneyW;
  let total = totalOf(ctx, s1) + totalOf(ctx, s2) - surcharge;
  total += ctx.phase === 'rail-early' ? w.doubleTempoRailEarly : w.doubleTempoOther;
  const touchesFarm = [i1, i2].some((i) =>
    [LINKS[i]!.a, LINKS[i]!.b, ...(LINK_EXTRA_ENDPOINTS[i] ?? [])].some(
      (e) => !isMerchantNode(e) && LOCATIONS[e]?.region === 'farm',
    ),
  );
  if (touchesFarm) total += w.doubleFarmLockBonus;
  return total;
}

// ---------------------------------------------------------------------------
// develop.rs — DEVELOP 评分
// ---------------------------------------------------------------------------

/** 研发 2 级+煤/酒厂的机会成本惩罚（护栏）。 */
function developGuardrailPenalty(ind: IndustryType, level: number): number {
  const g = CFG.guardrails;
  if (level < 2) return 0;
  if (ind === 'brewery') return g.developBreweryPenaltyBase + g.developBreweryPenaltyPerLevel * (level - 2);
  if (ind === 'coal') return g.developCoalPenaltyBase + g.developCoalPenaltyPerLevel * (level - 2);
  return 0;
}

/** develop_target_value：移除一块板块的抽象价值（unlocked = 露出的下一级）。 */
function developTargetValue(
  state: GameState,
  ctx: EvalCtx,
  ind: IndustryType,
  removed: TileDef,
  unlocked: TileDef | undefined,
): number {
  const w = CFG.develop;
  let v = removed.railEraBuildable ? w.railEraTile : w.canalEraTile;
  v += w.perLevel * removed.level;
  if (unlocked?.railEraBuildable) v += w.railUnlockBonus;
  // 酒厂是经济引擎（研发 1 级 → 建 2/3/4 级）；运河早期仅铁便宜时做。
  if (ind === 'brewery' && removed.level === 1) {
    v += w.breweryLv1Bonus;
    if (ctx.phase === 'canal-early') {
      // 有效铁价：版面有免费铁 = 0，否则市价（v1 同款映射；上游用市场铁价）。
      const freeIron = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
      const price = freeIron > 0 ? 0 : ironPrice(state);
      if (price < 2) v += w.ironPriceVeryCheapBonus;
      else if (price <= 2) v += w.ironPriceCheapBonus;
      else if (price <= 3) v += w.ironPriceMarginalBonus;
      else v += w.ironPriceExpensivePenalty;
    }
  }
  if (isCanalPhase(ctx.phase)) v += w.canalBonus;
  if (ctx.plan.industry === ind) v += w.planBonus;
  if (hasBuildableCard(state, ctx.pid, ind)) v += w.buildableCardBonus;
  return v - developGuardrailPenalty(ind, removed.level);
}

/** score_develop_plans：对一个合法 develop 行动（removals 1|2）评分。 */
function scoreDevelopOp(
  state: GameState,
  ctx: EvalCtx,
  action: Extract<Action, { type: 'develop' }>,
  developsInEra: number,
): number {
  const w = CFG.develop;
  const g = CFG.guardrails;
  const ps = state.players[ctx.pid]!;
  if (action.removals.length === 0) return Number.NEGATIVE_INFINITY;

  // 铁源与成本：免费铁厂方块优先，不足按市价。
  const boardIron = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
  const ironNeeded = action.removals.length;
  const ironBuy = Math.max(0, ironNeeded - boardIron);
  const ironCost = ironBuy > 0 ? buyIronCost(state, ironBuy) : 0;
  // 上游 can-develop 前置：无免费铁且市价 1 块都付不起 → 不可行。
  if (boardIron === 0 && ironPrice(state) > ps.money) return Number.NEGATIVE_INFINITY;
  if (ironCost > ps.money) return Number.NEGATIVE_INFINITY;

  // 逐次移除求值（同产业第二次移除针对下一级板块）。
  const seen = new Map<IndustryType, number>();
  const values: number[] = [];
  for (const ind of action.removals) {
    const offset = seen.get(ind) ?? 0;
    seen.set(ind, offset + 1);
    const removed = tileAfter(state, ctx.pid, ind, offset);
    if (!removed || !removed.developable) return Number.NEGATIVE_INFINITY;
    if (g.banDevelopIronLv2Plus && ind === 'iron' && removed.level >= 2) {
      return Number.NEGATIVE_INFINITY;
    }
    if (g.banDevelopBreweryLv2Canal && isCanalPhase(ctx.phase) && ind === 'brewery' && removed.level >= 2) {
      return Number.NEGATIVE_INFINITY;
    }
    values.push(developTargetValue(state, ctx, ind, removed, tileAfter(state, ctx.pid, ind, offset + 1)));
  }

  const first = values[0]!;
  const secondValue = values.length > 1 ? values[1]! * w.secondTargetScale : 0;
  // 铁稀缺且研发耗一整动：版面无免费铁时收真实机会成本。
  const ironScarcity = boardIron === 0 ? w.ironScarcityCost : 0;

  const p = parts({ vp: first + secondValue, money: -ironCost });
  if (isCanalPhase(ctx.phase)) {
    p.vp *= w.canalScale;
    p.strategic += values.length > 1 ? w.canalDoubleTargetBonus : -w.canalSingleTargetPenalty;
  }

  // 行动经济护栏：研发次数超限时陡增惩罚（本引擎无 develops 计数，
  // 由插件实例按自身决策追踪，见文件头注释）。
  const limit = isCanalPhase(ctx.phase) ? w.canalCountLimit : w.railCountLimit;
  const over = Math.max(0, developsInEra + 1 - limit);
  p.risk -= over * over * w.overLimitSteepness + over;
  p.risk -= ironScarcity;

  return totalOf(ctx, p);
}

// ---------------------------------------------------------------------------
// sell.rs — SELL 评分
// ---------------------------------------------------------------------------

/** 商人奖励折算成 ScoreParts（vp / £ / 收入格 / 免费研发）。 */
function merchantBonusParts(state: GameState, id: MerchantId): ScoreParts {
  const bonus = MERCHANTS[id].bonus;
  switch (bonus.type) {
    case 'vp':
      return parts({ vp: bonus.amount * CFG.value.vp });
    case 'money':
      return parts({ money: bonus.amount });
    case 'income':
      return parts({ income: bonus.amount });
    case 'develop':
      return parts({ strategic: CFG.sell.developBonusValue });
  }
}

/** score_sell_plans：对一个合法 sell 行动（引擎枚举的组合）评分。 */
function scoreSellOp(state: GameState, ctx: EvalCtx, action: Extract<Action, { type: 'sell' }>): number {
  const w = CFG.sell;
  if (action.sales.length === 0) return Number.NEGATIVE_INFINITY;

  const p = parts();
  for (const sale of action.sales) {
    const placed = state.board.slots[sale.location]?.[sale.slotIndex];
    if (!placed || placed.player !== ctx.pid || placed.flipped) return Number.NEGATIVE_INFINITY;
    p.vp += placed.tile.vp;
    p.income += placed.tile.incomeAdvance;
    if (sale.useMerchantBeer) addParts(p, merchantBonusParts(state, sale.merchant));
  }

  // 翻面推进收入 = 持续性现金流，显式加计。
  p.income *= 1 + w.incomeStreamShare;

  // 早期卖货主要为收入（VP 随时代末临近权重上升）。
  p.vp *= w.vpScaleFloor + w.vpScaleSpan * (1 - ctx.eraFrac);

  // 时代末紧迫：运河末 1 级可售板块不翻就永久消失；铁路末卖货即收官。
  if (isEraEndgame(ctx)) p.strategic += w.urgencyBonus;
  else if (ctx.phase === 'rail-late') p.strategic += w.railLateBaselineBonus;

  return totalOf(ctx, p);
}

// ---------------------------------------------------------------------------
// loan.rs — LOAN 评分
// ---------------------------------------------------------------------------

/** 预算内可负担的最佳建造分（上游 best_affordable_build_score）。 */
function bestAffordableBuildScore(state: GameState, ctx: EvalCtx, budget: number): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const t of ctx.targets) {
    const tile = nextTile(state, ctx.pid, t.industry);
    if (!tile) continue;
    if (buildCostOf(state, ctx.pid, tile, t.location).cash > budget) continue;
    // 注意：上游按预算过滤后仍以真实现金评分（超现金的拿 unaffordable 罚分）。
    const s = scoreBuildOp(state, ctx, t.industry, t.location);
    if (s > best) best = s;
  }
  return best === Number.NEGATIVE_INFINITY ? 0 : best;
}

/** score_loan_result：含同回合 combo 仿真（depth 防递归）。 */
function scoreLoanOp(
  state: GameState,
  ctx: EvalCtx,
  action: Extract<Action, { type: 'loan' }>,
  develops: DevelopCounts,
  depth: number,
): number {
  const w = CFG.loan;
  const pid = ctx.pid;
  const ps = state.players[pid]!;
  const postLoanIncome = incomeLevelAt(ps.incomeSpace) - w.incomePenalty;
  const cash = ps.money;

  const after = bestAffordableBuildScore(state, ctx, cash + w.amount);
  const now = bestAffordableBuildScore(state, ctx, cash);
  const gain = Math.max(0, after - now);

  const p = parts({ income: -w.incomePenalty, strategic: gain });

  // 同回合 combo：贷款后立即解锁一个生产性第二动（Loan → Build/...）。
  if (cash < w.comboCashThreshold && ctx.roundsRemaining > w.comboMinRoundsLeft && depth === 0) {
    try {
      const s1 = applyAction(state, action);
      if (s1.phase !== 'game-over' && s1.turnOrder[s1.currentPlayerIdx] === pid) {
        const simCtx = getCtx(s1, pid);
        let bestSecond = Number.NEGATIVE_INFINITY;
        const seen = new Set<string>();
        for (const a of enumerateActions(s1, pid)) {
          if (a.type === 'loan') continue;
          const key = operationKey(a);
          if (seen.has(key)) continue;
          seen.add(key);
          const s = scoreOp(s1, simCtx, a, develops, depth + 1);
          if (s > bestSecond) bestSecond = s;
        }
        if (bestSecond !== Number.NEGATIVE_INFINITY) {
          p.strategic += Math.max(0, bestSecond) * w.comboScale;
        }
      }
    } catch {
      // 仿真失败则不加 combo 分。
    }
  }

  // 闲置保护：手上的钱什么正事都干不了时就借。
  if (cash < w.idleCashThreshold) p.strategic += w.idleBonus;

  // 解锁加成：贷款让可负担建造出现。
  if (now <= 0 && after > w.unlockMinAfterScore) p.strategic += w.unlockBonus;

  // 创业贷款峰值：运河早期头两轮低现金（上游按时代内 round<=2，此处时代进度近似）。
  if (ctx.phase === 'canal-early' && eraProgress(state) < CFG.loan.startupMaxProgress) {
    p.strategic += cash < w.startupLowCashThreshold ? w.startupLowCashBonus : w.startupBonus;
  }

  // 运河末贷款：借铁路时代启动资金（上游按时代内 round>=6，此处时代进度近似）。
  if (ctx.phase === 'canal-late' && eraProgress(state) >= CFG.loan.canalLateMinProgress) {
    const canFlipSoon = Object.values(state.board.slots).some((slots) =>
      slots.some((t) => t && t.player === pid && !t.flipped && t.tile.sellable),
    );
    if (canFlipSoon && cash < w.canalLateCashThreshold) {
      p.strategic += cash < w.idleCashThreshold ? w.canalLateLowCashBonus : w.canalLateBonus;
    }
  }

  // 收入地板：绝不借进破产螺旋。
  p.risk -=
    postLoanIncome <= w.floorDeepDebtIncome
      ? w.floorDeepDebtPenalty
      : postLoanIncome <= w.floorDebtIncome
        ? w.floorDebtPenalty
        : postLoanIncome <= w.floorBreakevenIncome
          ? w.floorBreakevenPenalty
          : 0;

  // 现金充裕不滥借。
  p.risk -=
    cash >= w.richHeavyCash
      ? w.richHeavyPenalty
      : cash >= w.richModerateCash
        ? w.richModeratePenalty
        : cash >= w.richLightCash
          ? w.richLightPenalty
          : 0;

  return totalOf(ctx, p);
}

// ---------------------------------------------------------------------------
// scout_pass.rs — SCOUT / PASS 评分
// ---------------------------------------------------------------------------

/** scout_hand_refresh_score：搜寻后保留手牌的"急需换新"程度。 */
function handRefreshScore(retainedKeeps: number[]): number {
  const w = CFG.scout;
  if (retainedKeeps.length === 0) return 0;
  const n = retainedKeeps.length;
  const lowRatio = retainedKeeps.filter((s) => s <= w.lowKeep).length / n;
  const highCount = retainedKeeps.filter((s) => s >= w.highKeep).length;
  const highShortfall = clamp01(Math.max(0, w.desiredHighValue - highCount) / w.desiredHighValue);
  const anchor = CFG.cards.locationBase;
  const avg = retainedKeeps.reduce((s, x) => s + x, 0) / n;
  const avgShortfall = clamp01((anchor - avg) / anchor);
  return w.maxRefresh * lowRatio * (0.35 + 0.65 * highShortfall) * avgShortfall;
}

/** score_scout_plan：弃 3 张死卡 + 刷新手牌质量。 */
function scoreScoutOp(state: GameState, ctx: EvalCtx, action: Extract<Action, { type: 'scout' }>): number {
  const w = CFG.scout;
  const discarded = action.cardIds.map((id) => ctx.cardKeepById.get(id) ?? 0);
  if (discarded.length !== 3) return Number.NEGATIVE_INFINITY;
  const deadCount = discarded.filter((s) => s <= 0).length;
  const discardScore = deadCount * w.deadDiscardValue - (3 - deadCount) * w.aliveDiscardPenalty;

  const discardedIds = new Set(action.cardIds);
  const retained = state.players[ctx.pid]!.hand
    .filter((c) => !discardedIds.has(c.id))
    .map((c) => ctx.cardKeepById.get(c.id) ?? 0);
  return discardScore + handRefreshScore(retained);
}

// ---------------------------------------------------------------------------
// 操作层评分分发（scoreOp）+ 候选组装（candidate_actions_k 语义）
// ---------------------------------------------------------------------------

/** 本时代已做 develop 次数（实例追踪；仿真时按首动累加）。 */
interface DevelopCounts {
  canal: number;
  rail: number;
}

function developsInEra(state: GameState, d: DevelopCounts): number {
  return state.era === 'canal' ? d.canal : d.rail;
}

/** 一个合法行动的操作分（不含弃牌维度；同操作不同 cardId 同分）。 */
function scoreOp(state: GameState, ctx: EvalCtx, action: Action, develops: DevelopCounts, depth: number): number {
  switch (action.type) {
    case 'build':
      return scoreBuildOp(state, ctx, action.industry, action.location, action.slotIndex);
    case 'network':
      return scoreNetworkOp(state, ctx, action);
    case 'develop':
      return scoreDevelopOp(state, ctx, action, developsInEra(state, develops));
    case 'sell':
      return scoreSellOp(state, ctx, action);
    case 'loan':
      return scoreLoanOp(state, ctx, action, develops, depth);
    case 'scout':
      return scoreScoutOp(state, ctx, action);
    case 'pass':
      // scout_pass.rs：pass 在统一货币下自然为 0——低于任何正收益行动，
      // 高于任何亏钱行动，不再需要魔法负常数。
      return 0;
  }
}

/** 行动签名（剥 cardId/cardIds）：同操作不同弃牌视为同一候选。 */
function operationKey(action: Action): string {
  if (action.type === 'scout') return 'scout';
  return stableStringify({ ...action, cardId: undefined });
}

/** 候选分组键（上游 Top-K 粒度按行动域）。 */
function typeKey(action: Action): string {
  if (action.type === 'network') return action.links.length > 1 ? 'network2' : 'network1';
  return action.type;
}

/** 各行动域的候选上限：build/network 各 k；develop/sell 各 2（SOURCE_VARIANTS）；其余 1。 */
function typeCap(tk: string, k: number): number {
  if (tk === 'build' || tk === 'network1' || tk === 'network2') return k;
  if (tk === 'develop' || tk === 'sell') return 2;
  return 1;
}

interface Scored {
  action: Action;
  index: number;
  score: number;
  keep: number;
}

/**
 * 给 legal 逐条评分并排序：操作分降序；同分（同操作不同弃牌）取保留价值
 * 最低者；再按原数组序（确定性）。操作分按 operationKey 缓存（loan 的
 * combo 仿真等重活只对每个操作做一次）；scout 的分依赖具体弃牌组合
 * （op 签名恒为 'scout'），不参与缓存、逐条评分。
 */
function scoreLegal(state: GameState, ctx: EvalCtx, legal: Action[], develops: DevelopCounts, depth: number): Scored[] {
  const cache = new Map<string, number>();
  const scored = legal.map((action, index) => {
    let score: number;
    if (action.type === 'scout') {
      score = scoreOp(state, ctx, action, develops, depth);
    } else {
      const key = operationKey(action);
      const hit = cache.get(key);
      if (hit === undefined) {
        score = scoreOp(state, ctx, action, develops, depth);
        cache.set(key, score);
      } else {
        score = hit;
      }
    }
    return { action, index, score, keep: actionCardKeep(ctx, action) };
  });
  scored.sort((a, b) => b.score - a.score || a.keep - b.keep || a.index - b.index);
  return scored;
}

/** 按行动域各取 Top-K（candidate_actions_k 的候选组装语义），-inf 不进候选。 */
function topPerType(scored: Scored[], k: number): Scored[] {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const out: Scored[] = [];
  for (const x of scored) {
    if (x.score === Number.NEGATIVE_INFINITY) continue;
    const op = operationKey(x.action);
    if (seen.has(op)) continue;
    const tk = typeKey(x.action);
    const n = counts.get(tk) ?? 0;
    if (n >= typeCap(tk, k)) continue;
    seen.add(op);
    counts.set(tk, n + 1);
    out.push(x);
  }
  return out;
}

// ---------------------------------------------------------------------------
// lookahead.rs — 确定性 2-ply 同回合前瞻（choose_action）
// ---------------------------------------------------------------------------

/** 回合末现金惩罚：低现金且收入没起来时结束回合是危险的。 */
function endOfTurnPenalty(state: GameState, pid: PlayerIndex, incomeBefore: number): number {
  const lw = CFG.lookahead;
  const p = state.players[pid]!;
  if (p.money >= lw.lowMoneyThreshold) return 0;
  const incomeAfter = incomeLevelAt(p.incomeSpace);
  if (incomeAfter - incomeBefore >= lw.endTurnIncomeExempt) return 0;
  const scarcity = clamp01((lw.lowMoneyThreshold - p.money) / lw.lowMoneyThreshold);
  const incomeTerm = incomeAfter < 0 ? lw.endTurnNegativeIncomeWeight : lw.endTurnIncomeWeight;
  const runway = clamp01(roundsRemaining(state) / ERA_ROUNDS);
  const eraTerm = state.era === 'rail' ? lw.endTurnRailEraTerm : lw.endTurnCanalEraTerm;
  const runwayTerm = lw.endTurnRunwayBase + lw.endTurnRunwaySpan * (1 - runway);
  return -lw.endTurnPenaltyScale * scarcity * incomeTerm * eraTerm * runwayTerm;
}

/** choose_action：首动候选 × 次动最优的确定性前瞻，返回 legal 中的最佳行动。 */
function chooseAction(state: GameState, pid: PlayerIndex, legal: Action[], develops: DevelopCounts): Action {
  const ctx = getCtx(state, pid);
  const incomeBefore = incomeLevelAt(state.players[pid]!.incomeSpace);
  const scored = scoreLegal(state, ctx, legal, develops, 0);
  const firstCandidates = topPerType(scored, CFG.lookahead.firstActionK);

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
    if (s1.phase !== 'game-over' && s1.turnOrder[s1.currentPlayerIdx] === pid) {
      const develops1: DevelopCounts =
        c1.action.type === 'develop'
          ? state.era === 'canal'
            ? { canal: develops.canal + 1, rail: develops.rail }
            : { canal: develops.canal, rail: develops.rail + 1 }
          : develops;
      const s1Ctx = getCtx(s1, pid);
      const secondScored = scoreLegal(s1, s1Ctx, enumerateActions(s1, pid), develops1, 0);
      const bestSecond = topPerType(secondScored, CFG.lookahead.secondActionK)[0];
      if (bestSecond) {
        value = c1.score + ctx.profile.alpha * Math.max(0, bestSecond.score);
        try {
          endState = applyAction(s1, bestSecond.action);
        } catch {
          endState = s1;
        }
      }
    }
    value += endOfTurnPenalty(endState, pid, incomeBefore);
    if (!best || value > best.value) best = { action: c1.action, value };
  }

  // 兜底（上游 pass_decision 语义：无候选时也有 pass=0 在 scored 里）。
  return (best ?? scored[0]!).action;
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

const plugin: AgentPlugin = {
  meta: {
    name: 'heuristic-v20260829',
    version: '2.0.0',
    description: '启发式评分 AI（统一翻面概率模型，brass-assistant 2026-08-29 重构版移植）',
    author: 'brass-birmingham',
  },
  create: () => {
    // 本引擎状态无 develops_in_canal/rail 字段（上游 develop 次数护栏的输入），
    // 由实例按自身决策追踪；只统计自己的 develop 行动，语义与上游一致。
    const develops: DevelopCounts = { canal: 0, rail: 0 };
    return {
      decide: ({ state, seat, legal }) => {
        if (legal.length === 0) throw new Error('heuristic-v20260829: no legal actions');
        const action = chooseAction(state, seat, legal, develops);
        if (action.type === 'develop') {
          if (state.era === 'canal') develops.canal += 1;
          else develops.rail += 1;
        }
        return action;
      },
    };
  },
};

export default plugin;
