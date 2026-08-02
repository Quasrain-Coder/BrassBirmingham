/**
 * Build 行动：枚举 + 执行 + Overbuild（rules-reference §6.1/§6.2，§9.7/9.13/9.14）。
 *
 * 枚举规范化（Action 无槽位/目标参数，以下选择全部确定化）：
 * - 槽位/目标解析顺序：①对手煤/铁厂 overbuild ②空槽（先单图标后双图标，官方序）
 *   ③己方 overbuild（同产业多块取等级最低，并列槽位序）。
 *   对手 overbuild 优先于空槽：覆盖对手煤/铁厂剥夺其时代末/二次计分与 Link 图标，
 *   对建造者非支配（Action 无目标字段，同三元组的被支配空槽结果不单独枚举）。
 * - Overbuild 新板块须与被覆盖板块**同产业**且等级**严格更高**（官方规则书 "higher
 *   level tile of the same industry type"，己方/对手分支均适用；"覆盖自己任意产业"
 *   指被替换对象不限煤/铁，不是允许跨产业替换）。
 * - 对手 overbuild 附加前置：全图（含市场）该类方块为 0；且运河时代同地已有己方板块时
 *   禁用（覆盖对手是新增己方板块，会违反每地限 1 块；覆盖己方是替换，不受限）。
 * - 面板取该产业最低级板块（player.tiles 已按产业分组、等级升序，find 即最低级）。
 * - 煤源/铁源/市场购买的可行性预判与 consumeCoal/consumeIron 语义一致
 *   （免费源 + 市场购买总价 + 现金上限），故枚举只产出完全合法行动。
 *
 * 首建特例（§6.1，官方规则书 "Building If You Have No Tiles on the Board"）：
 * **当前玩家**自己无板块且无 Link 时，产业卡/Wild Industry 可建任意合法地点
 * （与对手是否有板块无关）。
 *
 * 执行顺序：印刷 £（入 spentThisRound）→ consumeCoal（建造地点）→ consumeIron
 * → 面板取板块放置（被覆盖板块连同资源直接移出游戏）→ 弃卡（Wild 卡回供应不进弃牌堆）
 * → 建成即卖市场（铁厂无条件；煤矿仅当 canBuyCoalFromMarket(建造地点)）→ 卖空立即翻面。
 * 翻面事件顺序：消耗导致的来源翻面在前，自建板块卖空翻面在最后。
 *
 * 纯函数：不改入参。
 */
import { LOCATIONS } from '../data/board.js';
import type { Card } from '../data/cards.js';
import { BREWERY_BARRELS } from '../data/market.js';
import type { TileDef } from '../data/tiles.js';
import { IllegalActionError } from '../errors.js';
import {
  buyCoalCost,
  buyIronCost,
  sellCoalToMarket,
  sellIronToMarket,
} from '../market.js';
import {
  canBuyCoalFromMarket,
  coalSources,
  ironSources,
  isConnected,
} from '../network.js';
import { applyFlip, consumeCoal, consumeIron } from '../resources.js';
import type { GameState, PlacedTile, PlayerState } from '../state.js';
import type {
  Action,
  GameEvent,
  IndustryType,
  LocationId,
  PlayerIndex,
} from '../types.js';

/** 产业枚举顺序（Location/Wild 卡的产业展开序，确定性）。 */
const ALL_INDUSTRIES: IndustryType[] = ['cotton', 'manufacturer', 'pottery', 'coal', 'iron', 'brewery'];

const LOCATION_IDS = Object.keys(LOCATIONS);
/** 20 个 named locations（排除 farm-north/farm-south；Wild Location 不可用农场）。 */
const NAMED_LOCATION_IDS = LOCATION_IDS.filter((id) => LOCATIONS[id]!.region !== 'farm');

/** 首建特例条件（§6.1）：当前玩家自己无板块且无 Link（按官方规则书，与对手无关）。 */
function playerBoardEmpty(state: GameState, player: PlayerIndex): boolean {
  if (state.board.links.some((l) => l.player === player)) return false;
  return Object.values(state.board.slots).every((slots) =>
    slots.every((t) => t === null || t.player !== player),
  );
}

/** 全图（含市场）某类资源方块总数（Overbuild 对手前置，§6.2/§9.13）。 */
function globalCubes(state: GameState, industry: 'coal' | 'iron'): number {
  let n = industry === 'coal' ? state.coalMarket : state.ironMarket;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.tile.industry === industry) n += t.resources;
    }
  }
  return n;
}

interface SlotTarget {
  slotIndex: number;
  overbuild: 'none' | 'own' | 'opponent';
}

/**
 * 规范化解析 (location, industry) 的目标槽位；null = 该处不可建该产业。
 * 顺序：对手 overbuild（非支配，优先）→ 空槽（单图标→双图标，官方序）→ 己方 overbuild
 * （同产业等级最低）。Overbuild 候选须同产业且 def.level 严格更高；
 * 对手候选另须全图该类方块为 0 且运河时代未被"每地限 1 块"阻断（canalBlocked）。
 */
function resolveSlot(
  state: GameState,
  player: PlayerIndex,
  location: LocationId,
  industry: IndustryType,
  def: TileDef,
): SlotTarget | null {
  const slotDefs = LOCATIONS[location]?.slots;
  const placed = state.board.slots[location];
  if (!slotDefs || !placed) return null;

  const canalBlocked =
    state.era === 'canal' && placed.some((t) => t !== null && t.player === player);

  // 1. 对手 overbuild：同产业煤/铁厂、等级严格更低、全图（含市场）该类方块为 0
  if (!canalBlocked && (industry === 'coal' || industry === 'iron') && globalCubes(state, industry) === 0) {
    for (let i = 0; i < slotDefs.length; i++) {
      if (!slotDefs[i]!.industries.includes(industry)) continue;
      const t = placed[i];
      if (t && t.player !== player && t.tile.industry === industry && t.tile.level < def.level) {
        return { slotIndex: i, overbuild: 'opponent' };
      }
    }
  }

  // 2. 空槽（运河时代同地已有己方板块时禁用，每地限 1 块）
  if (!canalBlocked) {
    for (const dual of [false, true]) {
      for (let i = 0; i < slotDefs.length; i++) {
        const sd = slotDefs[i]!;
        if ((sd.industries.length === 2) !== dual) continue;
        if (!sd.industries.includes(industry)) continue;
        if (placed[i] === null) return { slotIndex: i, overbuild: 'none' };
      }
    }
  }

  // 3. 己方 overbuild：同产业、等级严格更低；多块取等级最低（并列槽位序在前）
  let best: { slotIndex: number; level: number } | null = null;
  for (let i = 0; i < slotDefs.length; i++) {
    if (!slotDefs[i]!.industries.includes(industry)) continue;
    const t = placed[i];
    if (!t || t.player !== player || t.tile.industry !== industry || t.tile.level >= def.level) {
      continue;
    }
    if (!best || t.tile.level < best.level) best = { slotIndex: i, level: t.tile.level };
  }
  if (best) return { slotIndex: best.slotIndex, overbuild: 'own' };
  return null;
}

/** 现金可行性：印刷 £ + 煤（免费源不足且连通商人位时市场买）+ 铁（不足市场买），总价 ≤ 现金。 */
function affordable(
  state: GameState,
  player: PlayerIndex,
  location: LocationId,
  def: TileDef,
): boolean {
  let total = def.costMoney;
  if (def.costCoal > 0) {
    const free = coalSources(state, player, location).reduce((s, x) => s + x.tile.resources, 0);
    const need = def.costCoal - free;
    if (need > 0) {
      if (!canBuyCoalFromMarket(state, location)) return false;
      total += buyCoalCost(state, need);
    }
  }
  if (def.costIron > 0) {
    const free = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
    const need = def.costIron - free;
    if (need > 0) total += buyIronCost(state, need);
  }
  return total <= state.players[player]!.money;
}

/** 产业卡/Wild Industry 的候选地点：首建特例任意地点，否则 network 连通处。 */
function networkLocations(state: GameState, player: PlayerIndex, emptyBoard: boolean): LocationId[] {
  if (emptyBoard) return LOCATION_IDS;
  return LOCATION_IDS.filter((loc) => isConnected(state, player, loc));
}

function cardTargets(
  state: GameState,
  player: PlayerIndex,
  card: Card,
  emptyBoard: boolean,
): { locations: LocationId[]; industries: IndustryType[] } {
  switch (card.kind) {
    case 'location':
      return { locations: [card.location], industries: ALL_INDUSTRIES };
    case 'wild-location':
      return { locations: NAMED_LOCATION_IDS, industries: ALL_INDUSTRIES };
    case 'industry':
      return { locations: networkLocations(state, player, emptyBoard), industries: card.industries };
    case 'wild-industry':
      return { locations: networkLocations(state, player, emptyBoard), industries: ALL_INDUSTRIES };
  }
}

/**
 * 枚举完全合法的 Build 行动（钱够、资源可得、槽位/时代合法）。
 * 顺序确定性：手牌序 → 产业序 → LOCATIONS 键序。
 */
export function enumerateBuilds(state: GameState, player: PlayerIndex): Action[] {
  const ps = state.players[player]!;
  const emptyBoard = playerBoardEmpty(state, player);
  const out: Action[] = [];
  for (const card of ps.hand) {
    const { locations, industries } = cardTargets(state, player, card, emptyBoard);
    for (const industry of industries) {
      const def = ps.tiles.find((t) => t.industry === industry);
      if (!def) continue;
      if (state.era === 'canal' ? def.railEraOnly : !def.railEraBuildable) continue;
      for (const location of locations) {
        if (!resolveSlot(state, player, location, industry, def)) continue;
        if (!affordable(state, player, location, def)) continue;
        out.push({ type: 'build', cardId: card.id, industry, location });
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
 * 执行 Build。先以 enumerateBuilds 校验合法性（不在枚举集内抛 'illegal-build'），
 * 再按模块头注释的顺序结算。返回新 state 与翻面事件列表。
 */
export function applyBuild(
  state: GameState,
  player: PlayerIndex,
  action: Action,
): { state: GameState; events: GameEvent[] } {
  if (action.type !== 'build') {
    throw new IllegalActionError('not-a-build-action', `not-a-build-action: ${action.type}`);
  }
  const legal = enumerateBuilds(state, player).some(
    (a) =>
      a.type === 'build' &&
      a.cardId === action.cardId &&
      a.industry === action.industry &&
      a.location === action.location,
  );
  if (!legal) {
    throw new IllegalActionError(
      'illegal-build',
      `illegal-build: cannot build ${action.industry} at ${action.location} with card ${action.cardId}`,
    );
  }

  const events: GameEvent[] = [];
  let next = state;

  // 1. 印刷 £：放角色块（money 与 spentThisRound 同步，§9.9）
  const ps = next.players[player]!;
  const def = ps.tiles.find((t) => t.industry === action.industry)!;
  next = withPlayer(next, player, {
    ...ps,
    money: ps.money - def.costMoney,
    spentThisRound: ps.spentThisRound + def.costMoney,
  });

  // 2. 耗煤（建造地点连通最近源，不足市场买）→ 耗铁（全图任意源，不足市场买）
  const rc = consumeCoal(next, player, action.location, def.costCoal);
  next = rc.state;
  events.push(...rc.flipped);
  const ri = consumeIron(next, player, def.costIron);
  next = ri.state;
  events.push(...ri.flipped);

  // 3. 面板取最低级板块放置；被覆盖板块连同资源直接移出游戏（退回供应）
  const target = resolveSlot(next, player, action.location, action.industry, def)!;
  const psNow = next.players[player]!;
  const tileIdx = psNow.tiles.findIndex((t) => t === def);
  next = withPlayer(next, player, {
    ...psNow,
    tiles: [...psNow.tiles.slice(0, tileIdx), ...psNow.tiles.slice(tileIdx + 1)],
  });
  const placedTile: PlacedTile = {
    tile: def,
    player,
    flipped: false,
    resources: def.industry === 'brewery' ? BREWERY_BARRELS[next.era] : def.resourcesPlaced,
  };
  next = withSlotTile(next, action.location, target.slotIndex, placedTile);

  // 4. 弃卡：Wild 卡回 Wild 供应，不进弃牌堆（§9.14）
  const psNow2 = next.players[player]!;
  const cardIdx = psNow2.hand.findIndex((c) => c.id === action.cardId);
  const card = psNow2.hand[cardIdx]!;
  next = withPlayer(next, player, {
    ...psNow2,
    hand: [...psNow2.hand.slice(0, cardIdx), ...psNow2.hand.slice(cardIdx + 1)],
  });
  if (card.kind !== 'wild-location' && card.kind !== 'wild-industry') {
    next = { ...next, discard: [...next.discard, card] };
  }

  // 5. 建成即卖市场（仅本次行动，§9.7）：铁厂无条件；煤矿须连通商人位
  const industry = def.industry;
  if (
    (industry === 'coal' && canBuyCoalFromMarket(next, action.location)) ||
    industry === 'iron'
  ) {
    const sale =
      industry === 'coal'
        ? sellCoalToMarket(next, placedTile.resources)
        : sellIronToMarket(next, placedTile.resources);
    if (sale.sold > 0) {
      next =
        industry === 'coal'
          ? { ...next, coalMarket: next.coalMarket + sale.sold }
          : { ...next, ironMarket: next.ironMarket + sale.sold };
      const psNow3 = next.players[player]!;
      next = withPlayer(next, player, { ...psNow3, money: psNow3.money + sale.revenue });
      const remaining = placedTile.resources - sale.sold;
      next = withSlotTile(next, action.location, target.slotIndex, {
        ...placedTile,
        resources: remaining,
      });
      if (remaining === 0) {
        const f = applyFlip(next, action.location, target.slotIndex);
        next = f.state;
        events.push(f.event);
      }
    }
  }

  return { state: next, events };
}
