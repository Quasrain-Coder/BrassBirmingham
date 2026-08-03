/**
 * 资源消耗结算与翻面触发（rules-reference §6.1 / §6.5 / §9）。
 *
 * - 煤（§6.1）：建造地点 at 连通的最近未翻面煤矿免费取（任何玩家，coalSources
 *   已按距离+字典序排序）；不足从市场买——前提是 canBuyCoalFromMarket(state, at)，
 *   否则抛 IllegalActionError('coal-not-connected')。
 * - 铁（§9.1）：全图任意未翻面铁厂免费取，无需连通。规范化来源：LocationId 字典序
 *   首个"有足够方块"的铁厂供全部；无单厂足够则按字典序跨厂混源。不足市场买（无连通要求）。
 * - 啤酒（§6.5/§9.3）：来源自动解析——①useMerchantBeer 时优先取 at 所涉商人的桶
 *   （每次调用至多 1 桶，用了发 MerchantBonusEvent）②自己未翻面酒厂（全图可用）
 *   ③对手未翻面酒厂（须连通"用酒处" at）。②③各自按 LocationId 字典序+槽位序。
 * - 每移走一块煤/铁/啤酒即检查来源耗尽 → 立即 applyFlip（owner 进收入）。
 * - 市场买的现金在此扣减（money 与 spentThisRound 同步，§9.9 顺位计含买煤买铁花费）；
 *   钱不够抛 IllegalActionError('insufficient-funds')；啤酒总量不够抛 'insufficient-beer'。
 * - 商人奖励：vp/money/income 在此直接结算；gloucester 的 develop 奖励涉及面板操作，
 *   不在此结算——只发 MerchantBonusEvent，由 Sell 行动层处理。
 * - 原子性：所有校验（连通/资金/啤酒总量）先于任何状态修改，抛错时不产生部分结算。
 *
 * 全部纯函数：返回新 state，不改入参。
 */
import { MERCHANTS } from './data/board.js';
import { advanceIncomeSpace } from './data/income.js';
import { IllegalActionError } from './errors.js';
import { buyCoalCost, buyIronCost } from './market.js';
import {
  canBuyCoalFromMarket,
  coalSources,
  ironSources,
  reachableFrom,
} from './network.js';
import type { GameState, PlacedTile, PlayerState } from './state.js';
import type {
  FlipEvent,
  LocationId,
  MerchantBonusEvent,
  MerchantId,
  PlayerIndex,
} from './types.js';

export interface ConsumeBeerOpts {
  /** 用酒处：Sell 传所卖向的 MerchantId；其余（如双轨）传 LocationId。 */
  at: LocationId | MerchantId;
  /** 仅 Sell 传 true：允许消耗 at 所涉商人的啤酒桶并触发该商人奖励。 */
  useMerchantBeer: boolean;
}

export interface ConsumeResult {
  state: GameState;
  flipped: FlipEvent[];
}

export interface ConsumeBeerResult extends ConsumeResult {
  merchantBonus?: MerchantBonusEvent;
}

/** 替换某槽位的 PlacedTile（结构共享，纯函数）。 */
function withSlotTile(
  state: GameState,
  location: LocationId,
  slotIdx: number,
  tile: PlacedTile,
): GameState {
  const slots = state.board.slots[location];
  if (!slots) throw new RangeError(`unknown location: ${location}`);
  const newSlots = slots.slice();
  newSlots[slotIdx] = tile;
  return {
    ...state,
    board: { ...state.board, slots: { ...state.board.slots, [location]: newSlots } },
  };
}

/** 替换某玩家的 PlayerState（结构共享，纯函数）。 */
function withPlayer(
  state: GameState,
  player: PlayerIndex,
  p: PlayerState,
): GameState {
  const players = state.players.slice();
  players[player] = p;
  return { ...state, players };
}

/** 用引用相等定位 source.tile 在 slots 中的下标（coalSources/ironSources 不给槽位号）。 */
function slotIndexOf(state: GameState, location: LocationId, tile: PlacedTile): number {
  const idx = (state.board.slots[location] ?? []).findIndex((t) => t === tile);
  if (idx < 0) throw new RangeError(`source tile not found at ${location}`);
  return idx;
}

/**
 * 翻面 + owner 收入轨前进（advanceIncomeSpace，上限等级 30）。
 * 槽位无板块或已翻面抛 IllegalActionError('cannot-flip')——翻面只发生一次。
 * 事件 incomeAdvance 记板块标称前进格数（触顶截断不影响事件值）。
 */
export function applyFlip(
  state: GameState,
  location: LocationId,
  slotIdx: number,
): { state: GameState; event: FlipEvent } {
  const placed = state.board.slots[location]?.[slotIdx];
  if (!placed || placed.flipped) {
    throw new IllegalActionError(
      'cannot-flip',
      `cannot-flip: no unflipped tile at ${location} slot ${slotIdx}`,
    );
  }
  const owner = placed.player;
  let next = withSlotTile(state, location, slotIdx, { ...placed, flipped: true });
  const ps = next.players[owner]!;
  next = withPlayer(next, owner, {
    ...ps,
    incomeSpace: advanceIncomeSpace(ps.incomeSpace, placed.tile.incomeAdvance),
  });
  return {
    state: next,
    event: {
      kind: 'flip',
      player: owner,
      location,
      incomeAdvance: placed.tile.incomeAdvance,
    },
  };
}

/** 从指定槽位移走 count 个资源；耗尽（归 0）立即翻面并把事件推入 flipped。 */
function drain(
  state: GameState,
  location: LocationId,
  slotIdx: number,
  count: number,
  flipped: FlipEvent[],
): GameState {
  const placed = state.board.slots[location]![slotIdx]!;
  const remaining = placed.resources - count;
  let next = withSlotTile(state, location, slotIdx, { ...placed, resources: remaining });
  if (remaining === 0 && !placed.flipped) {
    const r = applyFlip(next, location, slotIdx);
    flipped.push(r.event);
    next = r.state;
  }
  return next;
}

interface Source {
  location: LocationId;
  slotIdx: number;
  available: number;
}

/** 市场购买结算：扣钱 + 累计本轮花费。 */
function payMarket(
  state: GameState,
  player: PlayerIndex,
  cost: number,
): GameState {
  const ps = state.players[player]!;
  return withPlayer(state, player, {
    ...ps,
    money: ps.money - cost,
    spentThisRound: ps.spentThisRound + cost,
  });
}

/**
 * 消耗 n 块煤（§6.1）：at 连通最近未翻面煤矿免费取，不足市场买。
 * 市场买需 canBuyCoalFromMarket(state, at)，否则抛 'coal-not-connected'；
 * 现金不足抛 'insufficient-funds'。n <= 0 为空操作。
 */
export function consumeCoal(
  state: GameState,
  player: PlayerIndex,
  at: LocationId,
  n: number,
): ConsumeResult {
  const flipped: FlipEvent[] = [];
  if (n <= 0) return { state, flipped };

  const sources: Source[] = coalSources(state, player, at).map((s) => ({
    location: s.location,
    slotIdx: slotIndexOf(state, s.location, s.tile),
    available: s.tile.resources,
  }));
  const freeTotal = sources.reduce((sum, s) => sum + s.available, 0);
  const fromMarket = Math.max(0, n - freeTotal);

  // 前置校验（先于任何修改）
  if (fromMarket > 0 && !canBuyCoalFromMarket(state, at)) {
    throw new IllegalActionError(
      'coal-not-connected',
      `coal-not-connected: ${at} is not connected to any merchant space; cannot buy ${fromMarket} coal from market`,
    );
  }
  const cost = fromMarket > 0 ? buyCoalCost(state, fromMarket) : 0;
  if (cost > state.players[player]!.money) {
    throw new IllegalActionError(
      'insufficient-funds',
      `insufficient-funds: coal from market costs £${cost}, player has £${state.players[player]!.money}`,
    );
  }

  let next = state;
  let need = n;
  for (const src of sources) {
    if (need === 0) break;
    const take = Math.min(need, src.available);
    next = drain(next, src.location, src.slotIdx, take, flipped);
    need -= take;
  }
  if (fromMarket > 0) {
    next = { ...next, coalMarket: Math.max(0, next.coalMarket - fromMarket) };
    next = payMarket(next, player, cost);
  }
  return { state: next, flipped };
}

/**
 * 消耗 n 块铁（§9.1）：任意未翻面铁厂免费取（无需连通）。
 * 规范化：LocationId 字典序首个有足够方块者供全部；无单厂足够则按字典序混源。
 * 不足市场买（无连通要求）；现金不足抛 'insufficient-funds'。n <= 0 为空操作。
 */
export function consumeIron(
  state: GameState,
  player: PlayerIndex,
  n: number,
): ConsumeResult {
  const flipped: FlipEvent[] = [];
  if (n <= 0) return { state, flipped };

  const sources: Source[] = ironSources(state).map((s) => ({
    location: s.location,
    slotIdx: slotIndexOf(state, s.location, s.tile),
    available: s.tile.resources,
  }));
  const freeTotal = sources.reduce((sum, s) => sum + s.available, 0);
  const fromMarket = Math.max(0, n - freeTotal);
  const cost = fromMarket > 0 ? buyIronCost(state, fromMarket) : 0;
  if (cost > state.players[player]!.money) {
    throw new IllegalActionError(
      'insufficient-funds',
      `insufficient-funds: iron from market costs £${cost}, player has £${state.players[player]!.money}`,
    );
  }

  // 来源计划：有单厂足够 → 首个（字典序）足够者供全部；否则按序混源
  const plan: { src: Source; take: number }[] = [];
  const enough = sources.find((s) => s.available >= n);
  if (enough) {
    plan.push({ src: enough, take: n });
  } else {
    let need = n;
    for (const src of sources) {
      if (need === 0) break;
      const take = Math.min(need, src.available);
      plan.push({ src, take });
      need -= take;
    }
  }

  let next = state;
  for (const { src, take } of plan) {
    next = drain(next, src.location, src.slotIdx, take, flipped);
  }
  if (fromMarket > 0) {
    next = { ...next, ironMarket: Math.max(0, next.ironMarket - fromMarket) };
    next = payMarket(next, player, cost);
  }
  return { state: next, flipped };
}

function isMerchantId(x: string): x is MerchantId {
  return Object.prototype.hasOwnProperty.call(MERCHANTS, x);
}

/**
 * 消耗 n 桶啤酒（§6.5/§9.3）。来源自动解析（规范化顺序）：
 * ① useMerchantBeer 且 at 为商人位 → 该商人的桶（每次调用至多 1 桶），
 *   用了发 MerchantBonusEvent 并在此结算 vp/money/income 奖励
 *   （gloucester 的 develop 奖励只发事件，由 Sell 行动层结算）；
 * ② 自己未翻面酒厂（全图可用，无需连通），LocationId 字典序+槽位序；
 * ③ 对手未翻面酒厂（须连通"用酒处" at），LocationId 字典序+槽位序。
 * 总量不足抛 'insufficient-beer'（先于任何修改）。n <= 0 为空操作。
 */
export function consumeBeer(
  state: GameState,
  player: PlayerIndex,
  n: number,
  opts: ConsumeBeerOpts,
): ConsumeBeerResult {
  const flipped: FlipEvent[] = [];
  if (n <= 0) return { state, flipped };

  const merchantId = isMerchantId(opts.at) ? opts.at : null;
  const merchantAvailable = opts.useMerchantBeer && merchantId ? state.merchants[merchantId].beer : 0;
  // 每次调用至多取 1 桶商人啤酒（契约 merchantBonus 为单事件；多块板块 Sell 时行动层多次调用）
  const merchantTake = Math.min(n, merchantAvailable, 1);

  const reach = reachableFrom(state, [opts.at]);
  const own: Source[] = [];
  const opponent: Source[] = [];
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (let i = 0; i < slots.length; i++) {
      const t = slots[i];
      if (!t || t.flipped || t.tile.industry !== 'brewery' || t.resources <= 0) continue;
      const src = { location: loc, slotIdx: i, available: t.resources };
      if (t.player === player) own.push(src);
      else if (reach.has(loc)) opponent.push(src);
    }
  }
  const byLocation = (a: Source, b: Source): number =>
    (a.location < b.location ? -1 : a.location > b.location ? 1 : 0) || a.slotIdx - b.slotIdx;
  own.sort(byLocation);
  opponent.sort(byLocation);

  // 前置校验：总量不足 → 抛错，不产生部分结算
  const total =
    merchantTake + own.reduce((s, x) => s + x.available, 0) + opponent.reduce((s, x) => s + x.available, 0);
  if (total < n) {
    throw new IllegalActionError(
      'insufficient-beer',
      `insufficient-beer: need ${n}, only ${total} available (merchant ${merchantTake}, own/opponent breweries)`,
    );
  }

  let next = state;
  let need = n;
  let merchantBonus: MerchantBonusEvent | undefined;

  if (merchantTake > 0 && merchantId) {
    const m = next.merchants[merchantId];
    next = { ...next, merchants: { ...next.merchants, [merchantId]: { ...m, beer: m.beer - 1 } } };
    need -= 1;
    const bonus = MERCHANTS[merchantId].bonus;
    const ps = next.players[player]!;
    if (bonus.type === 'vp') {
      next = withPlayer(next, player, { ...ps, vp: ps.vp + bonus.amount });
    } else if (bonus.type === 'money') {
      next = withPlayer(next, player, { ...ps, money: ps.money + bonus.amount });
    } else if (bonus.type === 'income') {
      next = withPlayer(next, player, {
        ...ps,
        incomeSpace: advanceIncomeSpace(ps.incomeSpace, bonus.amount),
      });
    }
    // bonus.type === 'develop'：不在此结算，仅发事件
    merchantBonus = { kind: 'merchant-bonus', player, merchant: merchantId };
  }

  for (const src of [...own, ...opponent]) {
    if (need === 0) break;
    const take = Math.min(need, src.available);
    next = drain(next, src.location, src.slotIdx, take, flipped);
    need -= take;
  }

  return {
    state: next,
    flipped,
    ...(merchantBonus ? { merchantBonus } : {}),
  };
}
