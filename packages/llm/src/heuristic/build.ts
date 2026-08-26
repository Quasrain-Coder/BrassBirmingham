/**
 * BUILD 评分。移植自 brass-assistant heuristic_ai/build.rs：
 * 市场饥渴度、孤岛煤矿惩罚、翻面概率估计、啤酒经济、免费搭车比率、
 * 计划（流派）对齐、铁路末"有酒才建产业"等。
 */
import {
  BREWERY_BARRELS,
  COAL_MARKET_PRICES,
  IRON_MARKET_PRICES,
  LINK_EXTRA_ENDPOINTS,
  LINKS,
  buyCoalCost,
  buyIronCost,
  canBuyCoalFromMarket,
  coalSources,
  ironSources,
  marketSellRevenue,
  reachableFrom,
  type Action,
  type GameState,
  type IndustryType,
  type LocationId,
  type MerchantId,
  type PlayerIndex,
  type TileDef,
} from '@brass/engine';
import {
  beerBarrelReachable,
  countBeerSources,
  merchantAccepts,
  merchantHasBeerFor,
  ownedBeerBarrels,
  sellableBeerDemand,
  vpEquivalent,
  type EvalContext,
} from './context.js';

const MERCHANT_IDS = [
  'shrewsbury',
  'gloucester',
  'oxford',
  'warrington',
  'nottingham',
] as MerchantId[];

/** 硬战略护栏（brass-assistant 同款）：不建 1 级酒厂（时代末消失、节奏差）。 */
const BAN_BUILD_LV1_BREWERY = true;

/** 某地点未建的本时代相邻连接数（network_expansion / open_links）。 */
function countOpenLinks(state: GameState, loc: LocationId): number {
  let n = 0;
  for (let i = 0; i < LINKS.length; i++) {
    const l = LINKS[i]!;
    if (state.era === 'canal' ? !l.canal : !l.rail) continue;
    if (state.board.links.some((bl) => bl.linkIndex === i)) continue;
    const eps = [l.a, l.b, ...(LINK_EXTRA_ENDPOINTS[i] ?? [])];
    if (eps.includes(loc)) n += 1;
  }
  return n;
}

/** 玩家是否拥有触及 loc 的 Link。 */
function ownsLinkTouching(
  state: GameState,
  pid: PlayerIndex,
  loc: LocationId,
): boolean {
  return state.board.links.some((bl) => {
    if (bl.player !== pid) return false;
    const l = LINKS[bl.linkIndex]!;
    return [l.a, l.b, ...(LINK_EXTRA_ENDPOINTS[bl.linkIndex] ?? [])].includes(
      loc,
    );
  });
}

export interface BuildCost {
  /** 实际现金支出（板块 £ + 市场煤铁；免费源抵扣）。 */
  cash: number;
  coalNeeded: number;
  ironNeeded: number;
  freeCoal: number;
  freeIron: number;
}

/** 建造成本估计：免费煤（连通矿）/铁（全图）抵扣后按市价补。 */
export function buildCostOf(
  state: GameState,
  pid: PlayerIndex,
  def: TileDef,
  loc: LocationId,
): BuildCost {
  const freeCoal =
    def.costCoal > 0
      ? Math.min(
          def.costCoal,
          coalSources(state, pid, loc).reduce((s, x) => s + x.tile.resources, 0),
        )
      : 0;
  const freeIron =
    def.costIron > 0
      ? Math.min(
          def.costIron,
          ironSources(state).reduce((s, x) => s + x.tile.resources, 0),
        )
      : 0;
  const coalBuy = def.costCoal - freeCoal;
  const ironBuy = def.costIron - freeIron;
  const cash =
    def.costMoney +
    (coalBuy > 0 ? buyCoalCost(state, coalBuy) : 0) +
    (ironBuy > 0 ? buyIronCost(state, ironBuy) : 0);
  return { cash, coalNeeded: def.costCoal, ironNeeded: def.costIron, freeCoal, freeIron };
}

/** 建成即卖市场的仿真（与引擎 applyBuild 同一口径：从最便宜空格填起）。 */
function simulateMarketSale(state: GameState, isCoal: boolean, cubes: number) {
  const prices = isCoal ? COAL_MARKET_PRICES : IRON_MARKET_PRICES;
  const filled = isCoal ? state.coalMarket : state.ironMarket;
  const { revenue, sold } = marketSellRevenue(prices, filled, cubes);
  return { cash: revenue, sold, total: cubes, flips: sold === cubes && cubes > 0 };
}

/** 翻面概率估计（build.rs estimate_flip_probability）。 */
function estimateFlipProbability(
  state: GameState,
  pid: PlayerIndex,
  ind: IndustryType,
  loc: LocationId,
): number {
  let base: number;
  if (ind === 'coal' || ind === 'iron') {
    // 资源厂靠消耗翻面：市场越空 → 对手必须来吃 → 翻得快；铁路时代煤需求极大。
    const isCoal = ind === 'coal';
    const cubes =
      state.players[pid]!.tiles.find((t) => t.industry === ind)
        ?.resourcesPlaced ?? 1;
    const capacity = isCoal ? 14 : 10;
    const market = isCoal ? state.coalMarket : state.ironMarket;
    const scarcity = Math.min(1, Math.max(0, (capacity - market) / capacity));
    const canSell = isCoal ? canBuyCoalFromMarket(state, loc) : true;
    if (isCoal && !canSell) {
      // 孤岛煤矿：建即卖不出去。运河时代几乎没人会铺路来吃 → 时代末消失；
      // 但市场煤价很高（6/7/8）时桌面消耗预期仍在。铁路时代需求普遍且急。
      if (state.era === 'canal') {
        const heat = Math.min(1, Math.max(0, (buyCoalCost(state, 1) - 5) / 3));
        base = Math.min(0.4, 0.12 + 0.18 * heat);
      } else {
        const heat = Math.min(1, Math.max(0, (buyCoalCost(state, 1) - 4) / 4));
        base = Math.min(0.9, 0.6 + 0.25 * heat);
      }
    } else {
      const sale = simulateMarketSale(state, isCoal, cubes);
      if (canSell && sale.flips) {
        base = 0.9;
      } else {
        const eraDemand = isCoal
          ? state.era === 'rail'
            ? 0.85
            : 0.55
          : state.era === 'rail'
            ? 0.5
            : 0.4;
        base = Math.min(0.9, eraDemand + 0.35 * scarcity);
      }
    }
  } else if (ind === 'brewery') {
    // 酒厂只有在真实啤酒需求下才会被喝空翻面：运河时代仅自家卖货需求，
    // 铁路时代加双轨保底需求。供大于求的酒厂会闲置不翻。
    const nextCubes = BREWERY_BARRELS[state.era];
    const demand =
      sellableBeerDemand(state, pid) + (state.era === 'rail' ? 1 : 0);
    const barrels = ownedBeerBarrels(state, pid) + nextCubes;
    if (demand <= 0.5 && state.era === 'canal') base = 0.25;
    else if (barrels > demand) base = 0.45;
    else base = 0.7;
  } else {
    // 可售板块只有"卖得掉"才翻：需连通收该产业的商人 + 有啤酒。
    base = 0.12;
    const reach = reachableFrom(state, [loc]);
    const hasMerchant = MERCHANT_IDS.some(
      (id) => reach.has(id) && merchantAccepts(state, id, ind),
    );
    if (hasMerchant) {
      const tile = state.players[pid]!.tiles.find((t) => t.industry === ind);
      const need = tile?.beerToFlip ?? 1;
      const beerOk =
        countBeerSources(state, loc, pid) >= need ||
        beerBarrelReachable(state, loc);
      base += beerOk ? 0.6 : 0.1;
    }
    if (countOpenLinks(state, loc) > 0) base += 0.1;
    const hand = state.players[pid]!.hand.length;
    if (hand === 0) base -= 10;
    else if (hand === 1) base -= 5;
    else if (hand <= 3) base -= 2;
  }
  return Math.min(1, Math.max(0.05, base));
}

/** 免费搭车比率：建造所需煤铁中能从版面免费源（任何玩家的矿）取到的比例。 */
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
    const cubes = coalSources(state, pid, loc).reduce(
      (s, x) => s + x.tile.resources,
      0,
    );
    free += Math.min(def.costCoal, cubes);
  }
  if (def.costIron > 0) {
    const cubes = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
    free += Math.min(def.costIron, cubes);
  }
  return Math.min(1, Math.max(0, free / needed));
}

/** build 行动评分（对应 score_build_candidate；action 须为 build）。
 *  cashOverride：用假想现金评估可负担性（loan 的"贷后解锁"估算用）。 */
export function scoreBuild(
  state: GameState,
  pid: PlayerIndex,
  action: Extract<Action, { type: 'build' }>,
  ctx: EvalContext,
  cashOverride?: number,
): number {
  const tile = state.players[pid]!.tiles.find(
    (t) => t.industry === action.industry,
  );
  if (!tile) return Number.NEGATIVE_INFINITY;
  if (BAN_BUILD_LV1_BREWERY && action.industry === 'brewery' && tile.level === 1) {
    return Number.NEGATIVE_INFINITY;
  }

  const loc = action.location;
  const cash = cashOverride ?? state.players[pid]!.money;
  const cost = buildCostOf(state, pid, tile, loc);
  if (cost.cash > cash) {
    // 买不起：重度折价（仍展示"贷款→建造"路径，但不做首选）
    return -(cost.cash - cash) * 0.3;
  }

  const flipProb = estimateFlipProbability(state, pid, action.industry, loc);
  const linkSelfValue = ownsLinkTouching(state, pid, loc)
    ? tile.linkIcons * flipProb * 0.5
    : 0;
  const isResource =
    action.industry === 'coal' || action.industry === 'iron';
  const resourceSelfSufficiency = isResource
    ? 0.15 * tile.resourcesPlaced
    : 0;

  // 市场饥渴调整：建成即卖的价值 = 现金回流 + 即翻收入；卖不掉的存留是浪费。
  let marketAdjust = 0;
  if (isResource) {
    const isCoal = action.industry === 'coal';
    const marketOk = isCoal ? canBuyCoalFromMarket(state, loc) : true;
    const scarcity = isCoal
      ? (14 - state.coalMarket) / 14
      : (0.6 * (10 - state.ironMarket)) / 10;
    if (marketOk) {
      const sale = simulateMarketSale(state, isCoal, tile.resourcesPlaced);
      const sellValue = sale.cash * ctx.profile.moneyW;
      const cashBackBonus =
        sale.cash > 0 ? sale.cash * 0.4 + (sale.flips ? 1.5 : 0) : 0;
      // 煤价尖峰（6/7/8）时连通煤矿建成即卖是顶级节奏打法。
      const coalSpikeBonus =
        isCoal && sale.sold > 0
          ? Math.min(1, Math.max(0, (buyCoalCost(state, 1) - 5) / 3)) *
            sale.sold *
            1.9 *
            (state.era === 'canal' ? 1.25 : 1.0)
          : 0;
      const scarcityValue = scarcity * (1 + sale.sold) * 0.6;
      // 铁路时代煤几乎被每个行动吃掉，存留不重罚。
      const leftoverPenalty =
        isCoal && state.era === 'rail' ? 0 : (sale.total - sale.sold) * 0.5;
      marketAdjust =
        sellValue +
        cashBackBonus +
        coalSpikeBonus +
        scarcityValue -
        leftoverPenalty;
    } else if (isCoal) {
      marketAdjust =
        state.era === 'canal'
          ? -0.5
          : scarcity * (1.2 + 0.25 * tile.resourcesPlaced);
    } else {
      marketAdjust = scarcity * 1.2;
    }
  }

  const networkExpansion = 0.1 * countOpenLinks(state, loc);

  // 铁路时代紧急供煤溢价：市场近空时任何合法煤矿都是战略资源。
  const railCoalShortageBonus =
    action.industry === 'coal' && state.era === 'rail'
      ? Math.min(1, Math.max(0, 1 - state.coalMarket / 14)) *
        (1 + 0.2 * Math.max(0, tile.level - 1)) *
        (0.7 + 0.15 * tile.resourcesPlaced) *
        3.0
      : 0;

  // 成本效率：(收入 + VP) / 成本，封顶 2。
  const costEfficiency =
    cost.cash > 0
      ? Math.min(2, (tile.incomeAdvance + tile.vp) / cost.cash)
      : 0;

  // 啤酒经济：可售板块要有商人+酒才值 VP；酒厂按需求匹配产出。
  let beerBonus = 0;
  if (tile.sellable) {
    const reach = reachableFrom(state, [loc]);
    const hasMerchant = MERCHANT_IDS.some(
      (id) => reach.has(id) && merchantAccepts(state, id, action.industry),
    );
    if (hasMerchant) beerBonus += 0.6;
    const beerOk =
      hasMerchant &&
      (countBeerSources(state, loc, pid) >= tile.beerToFlip ||
        beerBarrelReachable(state, loc));
    beerBonus += beerOk ? 0.8 : -0.3;
  } else if (action.industry === 'brewery') {
    const barrels = ownedBeerBarrels(state, pid) + BREWERY_BARRELS[state.era];
    const demand = sellableBeerDemand(state, pid);
    const surplus = Math.max(0, barrels - demand);
    const sellSupport = demand > 0 ? 0.8 : 0.4;
    const railBeerValue = state.era === 'rail' ? 2.0 : 0;
    beerBonus += sellSupport + railBeerValue - 0.6 * surplus;
  }

  // 2 级+板块翻面 VP 在两个时代末都计分。
  const doubleVp = tile.level >= 2 && state.era === 'rail' ? 2 : 1;

  const ratio = resourceSourceRatio(state, pid, tile, loc);
  const interactionBonus = Math.max(0, ratio - 0.5) * 0.8;

  let score =
    vpEquivalent(
      ctx.profile,
      tile.vp * flipProb * doubleVp + linkSelfValue,
      tile.incomeAdvance * flipProb,
      -cost.cash,
      0,
    ) +
    resourceSelfSufficiency +
    networkExpansion +
    railCoalShortageBonus +
    beerBonus +
    costEfficiency +
    marketAdjust +
    interactionBonus;

  // 计划（流派）软加成：运河早期先搭经济引擎，不急于锁定可售线。
  if (
    ctx.plan.count > 0 &&
    ctx.plan.industry === action.industry &&
    ctx.profile.phase !== 'canal-early'
  ) {
    score += 0.5;
  }

  // 铁路末"有酒才建产业"：有酒可卖的收官建造加分。
  if (ctx.profile.phase === 'rail-late' && tile.sellable) {
    const reach = reachableFrom(state, [loc]);
    const beerOk =
      countBeerSources(state, loc, pid) > 0 ||
      MERCHANT_IDS.some((id) => reach.has(id) && merchantHasBeerFor(state, id, action.industry));
    if (beerOk) score += 1.2;
  }

  return score;
}
