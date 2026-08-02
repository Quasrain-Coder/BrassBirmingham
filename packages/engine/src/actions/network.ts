/**
 * Network 铺路行动：枚举 + 执行（rules-reference §6.3，§9.2/§9.4）。
 *
 * 费用与资源：
 * - 运河时代：只能建 canal:true 的边，每次行动 1 条，£3，不耗煤。
 * - 铁路时代：只能建 rail:true 的边；1 条 £5，或同次行动 2 条 £15 + 1 啤酒。
 *   每条铁路各耗 1 煤，**逐条放置逐条判定**——煤源连通锚定"该条铁路放置后"的
 *   两端（沿已建边可达最近煤矿免费取，不足且连通商人位则市场买）。
 *   双轨啤酒必须来自酿酒厂（consumeBeer useMerchantBeer:false，§9.4），
 *   用对手酒厂时该酒厂须连通**第二条铁路放置后**的位置。
 * - 新 Link 须与己方 network 相邻（playerNetwork：己方板块地点 + 己方 Link 端点）；
 *   **当前玩家**无板块且无 Link 时任意空线可放（首建特例，§6.1，按当前玩家判定）。
 * - 同一条边只能有 1 条 Link（任何玩家）。
 *
 * 枚举规范化：
 * - 双轨 links 恒为升序对 [i, j]（i < j），顺序语义 = 放置顺序（i 先放）。
 * - 啤酒来源默认规范化（自己酒厂优先，其次字典序首个连通的对手酒厂，与 consumeBeer
 *   一致），枚举不产生 beerFromOpponentBrewery；该字段仅供调用方显式覆盖默认来源
 *   （例如故意喝对手最后一桶使其翻面）。
 * - 只产出完全合法行动：Link 费 + 逐条煤（含市场购买金）不超过现金；啤酒可得。
 *
 * 弃牌结算不在此模块（Task 11 applyAction 统一处理行动卡）。
 * applyNetwork 返回新 GameState，本行动产生的事件写入其 lastEvents。
 * 纯函数：不改入参。
 */
import { LINKS, LINK_EXTRA_ENDPOINTS, MERCHANTS } from '../data/board.js';
import { IllegalActionError } from '../errors.js';
import { buyCoalCost } from '../market.js';
import {
  canBuyCoalFromMarket,
  coalSources,
  playerNetwork,
  reachableFrom,
  type NetworkNode,
} from '../network.js';
import { applyFlip, consumeBeer, consumeCoal } from '../resources.js';
import type { GameState, PlacedTile, PlayerState } from '../state.js';
import type { Action, GameEvent, LocationId, PlayerIndex } from '../types.js';

const CANAL_LINK_COST = 3;
const RAIL_SINGLE_COST = 5;
const RAIL_DOUBLE_COST = 15;

function linkEndpoints(linkIndex: number): NetworkNode[] {
  const l = LINKS[linkIndex]!;
  return [l.a, l.b, ...(LINK_EXTRA_ENDPOINTS[linkIndex] ?? [])];
}

function isMerchantNode(x: string): boolean {
  return Object.prototype.hasOwnProperty.call(MERCHANTS, x);
}

/** 边的任一 named location 端点（资源连通锚点；两端点经该边互达，取哪个等价）。 */
function firstLocationEndpoint(linkIndex: number): LocationId {
  const l = LINKS[linkIndex]!;
  return (isMerchantNode(l.a) ? l.b : l.a) as LocationId;
}

/** 首建特例（§6.1）：当前玩家自己无板块且无 Link（与对手无关）。 */
function playerBoardEmpty(state: GameState, player: PlayerIndex): boolean {
  if (state.board.links.some((l) => l.player === player)) return false;
  return Object.values(state.board.slots).every((slots) =>
    slots.every((t) => t === null || t.player !== player),
  );
}

/** 当前时代可建、未被占用、与己方 network 相邻（首建特例全图）的单条候选边（下标升序）。 */
function singleCandidates(state: GameState, player: PlayerIndex): number[] {
  const empty = playerBoardEmpty(state, player);
  const net = empty ? null : playerNetwork(state, player);
  const out: number[] = [];
  for (let i = 0; i < LINKS.length; i++) {
    const l = LINKS[i]!;
    if (state.era === 'canal' ? !l.canal : !l.rail) continue;
    if (state.board.links.some((bl) => bl.linkIndex === i)) continue;
    if (net && !linkEndpoints(i).some((e) => net.has(e))) continue;
    out.push(i);
  }
  return out;
}

/** 在 state 上为玩家加铺一条 Link（结构共享，纯函数）。 */
function withLink(state: GameState, linkIndex: number, player: PlayerIndex): GameState {
  return {
    ...state,
    board: { ...state.board, links: [...state.board.links, { linkIndex, player }] },
  };
}

/**
 * 该条铁路放置后 1 块煤的可行性与计划市场价（与 consumeCoal 语义一致）：
 * 连通免费煤矿 → 0；否则须连通商人位且市场购买金 ≤ cash。不可行返回 null。
 */
function plannedCoalCost(
  state: GameState,
  player: PlayerIndex,
  at: LocationId,
  cash: number,
): number | null {
  const free = coalSources(state, player, at).reduce((s, x) => s + x.tile.resources, 0);
  if (free >= 1) return 0;
  if (!canBuyCoalFromMarket(state, at)) return null;
  const cost = buyCoalCost(state, 1);
  return cost <= cash ? cost : null;
}

/**
 * 双轨啤酒可行性（与 consumeBeer useMerchantBeer:false 语义一致，§9.4）：
 * 自己未翻面酒厂（全图）或连通 at 的对手未翻面酒厂，至少 1 桶。
 */
function breweryBeerAvailable(state: GameState, player: PlayerIndex, at: LocationId): boolean {
  const reach = reachableFrom(state, [at]);
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (const t of slots) {
      if (!t || t.flipped || t.tile.industry !== 'brewery' || t.resources <= 0) continue;
      if (t.player === player || reach.has(loc)) return true;
    }
  }
  return false;
}

/**
 * 枚举完全合法的 Network 行动（手牌序 → Link 下标升序；双轨升序对 [i,j]、i 先放）。
 * 铁路时代单条与双条分别枚举；双条要求 £15 + 1 酒厂啤酒 + 两条各自的煤。
 */
export function enumerateNetwork(state: GameState, player: PlayerIndex): Action[] {
  const ps = state.players[player]!;
  const out: Action[] = [];
  const singles = singleCandidates(state, player);

  for (const card of ps.hand) {
    if (state.era === 'canal') {
      if (ps.money < CANAL_LINK_COST) continue;
      for (const i of singles) out.push({ type: 'network', cardId: card.id, links: [i] });
      continue;
    }

    // 铁路时代：单条 £5 + 1 煤（逐条判定市场购买金）
    if (ps.money >= RAIL_SINGLE_COST) {
      for (const i of singles) {
        const sim = withLink(state, i, player);
        if (plannedCoalCost(sim, player, firstLocationEndpoint(i), ps.money - RAIL_SINGLE_COST) === null) {
          continue;
        }
        out.push({ type: 'network', cardId: card.id, links: [i] });
      }
    }

    // 双条 £15 + 1 啤酒：第一条放完判第一条的煤，第二条放完判第二条的煤与啤酒
    if (ps.money >= RAIL_DOUBLE_COST) {
      const cashAfterFee = ps.money - RAIL_DOUBLE_COST;
      for (const i of singles) {
        const sim1 = withLink(state, i, player);
        const cost1 = plannedCoalCost(sim1, player, firstLocationEndpoint(i), cashAfterFee);
        if (cost1 === null) continue;
        for (const j of singleCandidates(sim1, player)) {
          const sim2 = withLink(sim1, j, player);
          const at2 = firstLocationEndpoint(j);
          if (plannedCoalCost(sim2, player, at2, cashAfterFee - cost1) === null) continue;
          if (!breweryBeerAvailable(sim2, player, at2)) continue;
          out.push({ type: 'network', cardId: card.id, links: [i, j] });
        }
      }
    }
  }
  return out;
}

/** 替换某玩家的 PlayerState（结构共享）。 */
function withPlayer(state: GameState, player: PlayerIndex, p: PlayerState): GameState {
  const players = state.players.slice();
  players[player] = p;
  return { ...state, players };
}

/** 替换某槽位内容（结构共享）。 */
function withSlotTile(
  state: GameState,
  location: LocationId,
  slotIdx: number,
  tile: PlacedTile | null,
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

/**
 * 显式指定对手酒厂为双轨啤酒来源时的校验与消耗：
 * 该处须有对手未翻面、有桶的酒厂，且连通第二条铁路放置后的位置；
 * 耗尽立即翻面（applyFlip，owner 进收入）。
 */
function drinkPinnedOpponentBrewery(
  state: GameState,
  player: PlayerIndex,
  location: LocationId,
  at: LocationId,
  events: GameEvent[],
): GameState {
  const slots = state.board.slots[location];
  const idx = (slots ?? []).findIndex(
    (t) => t !== null && t.player !== player && !t.flipped && t.tile.industry === 'brewery' && t.resources > 0,
  );
  if (idx < 0 || !reachableFrom(state, [at]).has(location)) {
    throw new IllegalActionError(
      'illegal-beer-source',
      `illegal-beer-source: no connected opponent brewery with beer at ${location} (anchor ${at})`,
    );
  }
  const placed = state.board.slots[location]![idx]!;
  let next = withSlotTile(state, location, idx, { ...placed, resources: placed.resources - 1 });
  if (placed.resources - 1 === 0) {
    const f = applyFlip(next, location, idx);
    next = f.state;
    events.push(f.event);
  }
  return next;
}

/**
 * 执行 Network。先以 enumerateNetwork 校验合法性（不在枚举集内抛 'illegal-network'），
 * 再按"付 Link 费 → 逐条放置并逐条耗煤 → 双条耗 1 酒厂啤酒"结算。
 * 返回新 state；本行动产生的翻面事件写入 lastEvents。
 */
export function applyNetwork(
  state: GameState,
  player: PlayerIndex,
  action: Action,
): GameState {
  if (action.type !== 'network') {
    throw new IllegalActionError('not-a-network-action', `not-a-network-action: ${action.type}`);
  }
  const legal = enumerateNetwork(state, player).some(
    (a) =>
      a.type === 'network' &&
      a.cardId === action.cardId &&
      a.links.length === action.links.length &&
      a.links.every((v, k) => v === action.links[k]),
  );
  if (!legal) {
    throw new IllegalActionError(
      'illegal-network',
      `illegal-network: links [${action.links.join(', ')}] with card ${action.cardId}`,
    );
  }

  const events: GameEvent[] = [];
  let next = state;

  // 1. Link 费（放角色块：money 与 spentThisRound 同步，§9.9）
  const cost =
    state.era === 'canal'
      ? CANAL_LINK_COST
      : action.links.length === 2
        ? RAIL_DOUBLE_COST
        : RAIL_SINGLE_COST;
  const ps = next.players[player]!;
  next = withPlayer(next, player, {
    ...ps,
    money: ps.money - cost,
    spentThisRound: ps.spentThisRound + cost,
  });

  // 2. 逐条放置、逐条耗煤（煤源连通锚定该条放置后的端点）
  let atLast: LocationId | null = null;
  for (const i of action.links) {
    next = withLink(next, i, player);
    const at = firstLocationEndpoint(i);
    atLast = at;
    if (next.era === 'rail') {
      const rc = consumeCoal(next, player, at, 1);
      next = rc.state;
      events.push(...rc.flipped);
    }
  }

  // 3. 双条：1 桶酒厂啤酒（不可用商人啤酒，§9.4）；锚点 = 第二条铁路放置后的位置
  if (action.links.length === 2) {
    if (action.beerFromOpponentBrewery !== undefined) {
      next = drinkPinnedOpponentBrewery(
        next,
        player,
        action.beerFromOpponentBrewery,
        atLast!,
        events,
      );
    } else {
      const rb = consumeBeer(next, player, 1, { at: atLast!, useMerchantBeer: false });
      next = rb.state;
      events.push(...rb.flipped);
    }
  }

  return { ...next, lastEvents: events };
}
