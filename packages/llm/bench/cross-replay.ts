/**
 * 临时跨引擎重放器：把 brass-assistant dump_trace 的轨迹 JSON 在我们引擎上重放，
 * 逐步校验行动合法性与状态一致性，时代切换处用对方 rail 快照同步手牌/牌堆
 * （两边洗牌 RNG 不同，牌身份无法跨时代延续），最终对比 VP/收入/现金。
 */
import { readFileSync } from 'node:fs';
import {
  applyAction,
  enumerateActions,
  scoreEraLinks,
  scoreFlippedIndustries,
  tileDef,
  type Action,
  type Card,
  type GameState,
  type IndustryType,
  type LocationId,
  type MerchantId,
  type PlayerIndex,
  type TileDef,
} from '@brass/engine';

// ---------------------------------------------------------------------------
// 映射表
// ---------------------------------------------------------------------------

const LOC_MAP: Record<string, LocationId | MerchantId> = {
  Belper: 'belper', Derby: 'derby', Leek: 'leek', StokeOnTrent: 'stoke-on-trent',
  Stone: 'stone', Uttoxeter: 'uttoxeter', Stafford: 'stafford',
  BurtonOnTrent: 'burton-on-trent', Cannock: 'cannock', Tamworth: 'tamworth',
  Walsall: 'walsall', Wolverhampton: 'wolverhampton',
  Coalbrookdale: 'coalbrookdale', Dudley: 'dudley', Kidderminster: 'kidderminster',
  Worcester: 'worcester', Birmingham: 'birmingham', Coventry: 'coventry',
  Nuneaton: 'nuneaton', Redditch: 'redditch',
  Shrewsbury: 'shrewsbury', Gloucester: 'gloucester', Oxford: 'oxford',
  Warrington: 'warrington', Nottingham: 'nottingham',
  BreweryNorth: 'farm-north', BrewerySouth: 'farm-south',
};

const IND_MAP: Record<string, IndustryType> = {
  CottonMill: 'cotton', Manufacturer: 'manufacturer', Pottery: 'pottery',
  CoalMine: 'coal', IronWorks: 'iron', Brewery: 'brewery',
};

/** 对方 city_tiles 扁平顺序（ALL_LOCATIONS 前 20）及各城槽位数。 */
const CITY_ORDER: { id: LocationId; slots: number }[] = [
  { id: 'belper', slots: 3 }, { id: 'derby', slots: 3 }, { id: 'leek', slots: 2 },
  { id: 'stoke-on-trent', slots: 3 }, { id: 'stone', slots: 2 },
  { id: 'uttoxeter', slots: 2 }, { id: 'stafford', slots: 2 },
  { id: 'burton-on-trent', slots: 2 }, { id: 'cannock', slots: 2 },
  { id: 'tamworth', slots: 2 }, { id: 'walsall', slots: 2 },
  { id: 'wolverhampton', slots: 2 }, { id: 'coalbrookdale', slots: 3 },
  { id: 'dudley', slots: 2 }, { id: 'kidderminster', slots: 2 },
  { id: 'worcester', slots: 2 }, { id: 'birmingham', slots: 4 },
  { id: 'coventry', slots: 3 }, { id: 'nuneaton', slots: 2 },
  { id: 'redditch', slots: 2 },
];
const CITY_OFFSETS: number[] = [];
{
  let acc = 0;
  for (const c of CITY_ORDER) {
    CITY_OFFSETS.push(acc);
    acc += c.slots;
  }
}

function flatToSlot(flat: number): { location: LocationId; slotIndex: number } {
  for (let i = 0; i < CITY_ORDER.length; i++) {
    const off = CITY_OFFSETS[i]!;
    const n = CITY_ORDER[i]!.slots;
    if (flat >= off && flat < off + n) {
      return { location: CITY_ORDER[i]!.id, slotIndex: flat - off };
    }
  }
  throw new Error(`bad flat index ${flat}`);
}

// ---------------------------------------------------------------------------
// JSON 类型（serde 输出形状）
// ---------------------------------------------------------------------------

type TheirCard =
  | { Location: string }
  | { Industry: { industries: string[]; n: number } }
  | 'WildLocation'
  | 'WildIndustry';

interface TheirTile {
  player: number;
  ind: string;
  def: { level: number };
  flipped: boolean;
  resource_cubes: number;
}

interface TheirPlayer {
  money: number;
  income_space: number;
  vp: number;
  hand: TheirCard[];
  industry_next: number[];
  canal_links: number;
  rail_links: number;
}

interface TheirState {
  era: 'Canal' | 'Rail';
  round: number;
  turn_order: number[];
  current_index: number;
  actions_this_turn: number;
  players: TheirPlayer[];
  money_spent_this_round: number[];
  city_tiles: (TheirTile | null)[];
  farm_tiles: (TheirTile | null)[];
  links: ({ player: number; is_canal: boolean } | null)[];
  coal_market: number;
  iron_market: number;
  merchants: { loc: string; buys: string | { Industry: string }; has_beer: boolean }[];
  deck: TheirCard[];
  discard_pile: TheirCard[];
  wild_location_pile: number;
  wild_industry_pile: number;
}

interface Trace {
  seed: number;
  players: number;
  initial: TheirState;
  rail: TheirState | null;
  moves: { player: number; mv: Record<string, unknown>; after: TheirState }[];
  final_vps: number[];
  final_income_spaces: number[];
  final_money: number[];
}

// ---------------------------------------------------------------------------
// 状态映射
// ---------------------------------------------------------------------------

let cardCounter = 0;
function mapCard(c: TheirCard): Card {
  const id = `t${cardCounter++}`;
  if (c === 'WildLocation') return { id, kind: 'wild-location' };
  if (c === 'WildIndustry') return { id, kind: 'wild-industry' };
  if (typeof c === 'object' && 'Location' in c) {
    return { id, kind: 'location', location: LOC_MAP[c.Location]! };
  }
  if (typeof c === 'object' && 'Industry' in c) {
    const inds = c.Industry.industries.slice(0, c.Industry.n).map((x) => IND_MAP[x]!);
    return { id, kind: 'industry', industries: inds };
  }
  throw new Error(`bad card ${JSON.stringify(c)}`);
}

function mapPlaced(t: TheirTile): { tile: TileDef; player: PlayerIndex; flipped: boolean; resources: number } {
  const industry = IND_MAP[t.ind]!;
  const def = tileDef(industry, t.def.level);
  if (!def) throw new Error(`no tileDef ${industry} L${t.def.level}`);
  return { tile: def, player: t.player, flipped: t.flipped, resources: t.resource_cubes };
}

/** 对方 industry_next[6] 的下标顺序（data.rs IndustryType::ALL）。 */
const THEIR_INDUSTRY_ORDER: IndustryType[] = [
  'cotton', 'coal', 'iron', 'manufacturer', 'pottery', 'brewery',
];

function mapState(their: TheirState, playerCount: 2 | 3 | 4): GameState {
  // 板块堆：完整展开栈减去各产业已消耗（industry_next）的前缀
  const stacks: Record<IndustryType, TileDef[]> = {
    cotton: [], manufacturer: [], pottery: [], coal: [], iron: [], brewery: [],
  };
  for (const ind of Object.keys(stacks) as IndustryType[]) {
    for (let level = 1; level <= 8; level++) {
      const def = tileDef(ind, level);
      if (!def) continue;
      for (let i = 0; i < def.count; i++) stacks[ind]!.push(def);
    }
  }
  const slots: GameState['board']['slots'] = {};
  for (const [i, c] of CITY_ORDER.entries()) {
    const off = CITY_OFFSETS[i]!;
    slots[c.id] = [];
    for (let s = 0; s < c.slots; s++) {
      const t = their.city_tiles[off + s];
      slots[c.id]!.push(t ? mapPlaced(t) : null);
    }
  }
  slots['farm-north'] = [their.farm_tiles[0] ? mapPlaced(their.farm_tiles[0]!) : null];
  slots['farm-south'] = [their.farm_tiles[1] ? mapPlaced(their.farm_tiles[1]!) : null];

  const merchants = {} as GameState['merchants'];
  for (const id of ['shrewsbury', 'gloucester', 'oxford', 'warrington', 'nottingham'] as MerchantId[]) {
    merchants[id] = { tiles: [], barrels: [] };
  }
  for (const m of their.merchants) {
    const id = LOC_MAP[m.loc]! as MerchantId;
    const tile =
      m.buys === 'Blank' ? 'blank'
      : m.buys === 'Any' ? 'any'
      : IND_MAP[(m.buys as { Industry: string }).Industry]!;
    merchants[id].tiles.push(tile as GameState['merchants'][MerchantId]['tiles'][number]);
    merchants[id].barrels.push(m.has_beer);
  }

  const links: GameState['board']['links'] = [];
  for (const [i, l] of their.links.entries()) {
    if (l) links.push({ linkIndex: i, player: l.player, era: l.is_canal ? 'canal' : 'rail' });
  }

  return {
    playerCount,
    era: their.era === 'Canal' ? 'canal' : 'rail',
    round: their.round,
    board: { slots, links },
    merchants,
    wildSupply: { location: their.wild_location_pile, industry: their.wild_industry_pile },
    coalMarket: their.coal_market,
    ironMarket: their.iron_market,
    deck: their.deck.slice().reverse().map(mapCard),
    discard: their.discard_pile.map(mapCard),
    players: their.players.map((p, i) => ({
      hand: p.hand.map(mapCard),
      tiles: THEIR_INDUSTRY_ORDER.flatMap((ind, k) =>
        stacks[ind]!.slice(p.industry_next[k] ?? 0),
      ),
      money: p.money,
      incomeSpace: p.income_space,
      vp: p.vp,
      spentThisRound: their.money_spent_this_round[i] ?? 0,
    })),
    turnOrder: their.turn_order,
    currentPlayerIdx: their.current_index,
    actionsThisTurn: their.actions_this_turn,
    rngState: 0,
    lastEvents: [],
    eraEndPending: false,
    roundEndPending: false,
    phase: 'action',
    winner: null,
  };
}

// ---------------------------------------------------------------------------
// 行动匹配
// ---------------------------------------------------------------------------

/** 对方煤源 JSON（逐块）→ 我方 coalSources（免费矿部分按槽聚合；市场部分余量自动）。 */
function theirCoalToOurs(
  arr: { mine: boolean; key: number; free: boolean }[] | undefined,
): { location: LocationId; slotIndex: number; count: number }[] | undefined {
  if (!arr) return undefined;
  const grouped = new Map<string, { location: LocationId; slotIndex: number; count: number }>();
  for (const c of arr) {
    if (!c.mine || !c.free || c.key === Number.MAX_SAFE_INTEGER || c.key >= 47) continue;
    const { location, slotIndex } = flatToSlot(c.key);
    const k = `${location}|${slotIndex}`;
    const g = grouped.get(k) ?? { location, slotIndex, count: 0 };
    g.count += 1;
    grouped.set(k, g);
  }
  return grouped.size > 0 ? [...grouped.values()] : undefined;
}

/** 对方铁源 JSON（逐块）→ 我方 ironSources。 */
function theirIronToOurs(
  arr: { key: number; free: boolean }[] | undefined,
): { location: LocationId; slotIndex: number; count: number }[] | undefined {
  if (!arr) return undefined;
  const grouped = new Map<string, { location: LocationId; slotIndex: number; count: number }>();
  for (const c of arr) {
    if (!c.free || c.key >= 47) continue;
    const { location, slotIndex } = flatToSlot(c.key);
    const k = `${location}|${slotIndex}`;
    const g = grouped.get(k) ?? { location, slotIndex, count: 0 };
    g.count += 1;
    grouped.set(k, g);
  }
  return grouped.size > 0 ? [...grouped.values()] : undefined;
}

interface TheirBeer {
  kind: 'own' | 'opponent' | 'merchant';
  key: number;
  farm_idx: number | null;
  merchant_idx: number | null;
}

/** 对方单块煤源（network 用）→ 我方 {location, slotIndex} 或 null（市场/缺省）。 */
function theirLinkCoal(
  c: { mine: boolean; key: number; free: boolean } | null | undefined,
): { location: LocationId; slotIndex: number } | null {
  if (!c || !c.mine || !c.free || c.key >= 47) return null;
  return flatToSlot(c.key);
}

/** 对方啤酒源（酒厂类）→ 我方 beerSource {location, slotIndex}。 */
function theirBrewerySource(b: TheirBeer): { location: LocationId; slotIndex: number } {
  if (b.farm_idx !== null && b.farm_idx !== undefined) {
    return { location: b.farm_idx === 0 ? 'farm-north' : 'farm-south', slotIndex: 0 };
  }
  return flatToSlot(b.key);
}

/** 对方商人桶 merchant_idx（全局商人板块数组下标）→ 我方 tileIndex（商人位内下标）。 */
function theirMerchantTileIndex(globalIdx: number): number {
  const ms = readTrace.initial.merchants;
  const loc = ms[globalIdx]!.loc;
  return ms.slice(0, globalIdx).filter((m) => m.loc === loc).length;
}

/** 对方一坨啤酒源 → 我方 BeerSourceRef[]（仅含酒厂与商人桶）。 */
function theirBeerRefs(arr: TheirBeer[]): import('@brass/engine').BeerSourceRef[] {
  const out: import('@brass/engine').BeerSourceRef[] = [];
  for (const b of arr) {
    if (b.kind === 'merchant') {
      out.push({ kind: 'merchant', tileIndex: theirMerchantTileIndex(b.merchant_idx!) });
    } else {
      const { location, slotIndex } = theirBrewerySource(b);
      out.push({ kind: 'brewery', location, slotIndex });
    }
  }
  return out;
}

function saleKey(s: { location: string; slotIndex: number; merchant: string; useMerchantBeer: boolean }): string {
  return `${s.location}|${s.slotIndex}|${s.merchant}|${s.useMerchantBeer ? 1 : 0}`;
}

function findMatch(
  state: GameState,
  pid: PlayerIndex,
  mv: Record<string, unknown>,
  legal: Action[],
): Action | null {
  const hand = state.players[pid]!.hand;
  const cardId = (idx: number) => hand[idx]?.id;
  const kind = mv.kind as string;
  switch (kind) {
    case 'build': {
      const found = legal.find(
        (a) =>
          a.type === 'build' &&
          a.industry === IND_MAP[mv.ind as string] &&
          a.location === LOC_MAP[mv.loc as string] &&
          a.cardId === cardId(mv.card_index as number),
      ) as Extract<Action, { type: 'build' }> | undefined;
      if (!found) return null;
      const coalSources = theirCoalToOurs(mv.coal as never);
      const ironSources = theirIronToOurs(mv.iron as never);
      return {
        ...found,
        slotIndex: mv.slot_index as number,
        ...(coalSources ? { coalSources } : {}),
        ...(ironSources ? { ironSources } : {}),
      };
    }
    case 'network': {
      const found = legal.find(
        (a) =>
          a.type === 'network' &&
          a.links.length === 1 &&
          a.links[0] === (mv.conn_id as number) &&
          a.cardId === cardId(mv.card_index as number),
      ) as Extract<Action, { type: 'network' }> | undefined;
      if (!found) return null;
      return { ...found, coalSources: [theirLinkCoal(mv.coal as never)] };
    }
    case 'network-double': {
      const found = legal.find(
        (a) =>
          a.type === 'network' &&
          a.links.length === 2 &&
          a.links[0] === (mv.conn1 as number) &&
          a.links[1] === (mv.conn2 as number) &&
          a.cardId === cardId(mv.card_index as number),
      ) as Extract<Action, { type: 'network' }> | undefined;
      if (!found) return null;
      return {
        ...found,
        coalSources: [
          theirLinkCoal(mv.coal1 as never),
          theirLinkCoal(mv.coal2 as never),
        ],
        beerSource: theirBrewerySource(mv.beer as never),
      };
    }
    case 'develop': {
      const want = [IND_MAP[mv.ind1 as string]!];
      if (mv.ind2) want.push(IND_MAP[mv.ind2 as string]!);
      want.sort();
      const found =
        legal.find((a) => {
          if (a.type !== 'develop' || a.cardId !== cardId(mv.card_index as number)) return false;
          const got = [...a.removals].sort();
          return got.length === want.length && got.every((x, i) => x === want[i]);
        }) ?? null;
      if (!found || found.type !== 'develop') return null;
      const ironSources = theirIronToOurs(mv.iron as never);
      return { ...found, ...(ironSources ? { ironSources } : {}) };
    }
    case 'sell': {
      const keys = mv.keys as number[];
      const merchantsIdx = mv.merchant_indices as number[];
      const useMerchant = mv.use_merchant_beer as boolean[];
      const trace = readTrace;
      const sales = keys.map((k, i) => {
        const { location, slotIndex } = flatToSlot(k);
        const mLoc = trace.initial.merchants[merchantsIdx[i]!]!.loc;
        return {
          location,
          slotIndex,
          merchant: LOC_MAP[mLoc]! as MerchantId,
          useMerchantBeer: useMerchant[i]!,
        };
      });
      const want = sales.map(saleKey).sort();
      const found = legal.find((a) => {
        if (a.type !== 'sell' || a.cardId !== cardId(mv.card_index as number)) return false;
        const got = a.sales.map(saleKey).sort();
        return got.length === want.length && got.every((x, i) => x === want[i]);
      }) as Extract<Action, { type: 'sell' }> | undefined;
      // 格洛斯特免费研发的移除目标：对方显式选择 → 我方 bonusDevelop 显式字段
      const bonus = mv.free_develop ? IND_MAP[mv.free_develop as string]! : undefined;
      // 对方逐桶显式啤酒来源 → 我方 beerSources（含商人桶 tileIndex）；
      // 按 (location|slotIndex) 对齐到每块板块（found 的 sales 顺序与轨迹可能不同）
      const beerByTile = new Map<string, import('@brass/engine').BeerSourceRef[]>();
      if (mv.beer_sources || useMerchant.some(Boolean)) {
        keys.forEach((k, i) => {
          const { location, slotIndex } = flatToSlot(k);
          const refs = theirBeerRefs(
            ((mv.beer_sources as TheirBeer[][] | undefined) ?? [])[i] ?? [],
          );
          // use_merchant_beer=true 时商人桶不在 beer_sources 里列出（由标志位隐含）
          if (useMerchant[i] && !refs.some((r) => r.kind === 'merchant')) {
            refs.unshift({ kind: 'merchant' });
          }
          if (refs.length > 0) beerByTile.set(`${location}|${slotIndex}`, refs);
        });
      }
      const withBeer = (a: Extract<Action, { type: 'sell' }>): Action => ({
        ...a,
        sales: a.sales.map((s) => {
          const refs = beerByTile.get(`${s.location}|${s.slotIndex}`);
          return refs ? { ...s, beerSources: refs } : { ...s };
        }),
        ...(bonus ? { bonusDevelop: bonus } : {}),
      });
      if (found) {
        return withBeer(found);
      }
      // 枚举外组合（我方 sell 枚举只产出规范化最大集及其减一子集，不覆盖同尺寸的
      // 替代路径）：直接按轨迹构造——applySell 的组合式校验会验证其合法性。
      const constructed: Action = {
        type: 'sell',
        cardId: cardId(mv.card_index as number) ?? '',
        sales,
      };
      console.log('  [sell 枚举外组合] 直接按轨迹构造提交');
      return withBeer(constructed);
    }
    case 'loan':
      return legal.find((a) => a.type === 'loan' && a.cardId === cardId(mv.card_index as number)) ?? null;
    case 'pass':
      return legal.find((a) => a.type === 'pass' && a.cardId === cardId(mv.card_index as number)) ?? null;
    case 'scout': {
      const want = (mv.card_indices as number[]).map((i) => cardId(i)).sort().join(',');
      return (
        legal.find((a) => {
          if (a.type !== 'scout') return false;
          return [...a.cardIds].sort().join(',') === want;
        }) ?? null
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 逐步状态对比（牌只比牌面不比 id）
// ---------------------------------------------------------------------------

function cardFace(c: Card): string {
  switch (c.kind) {
    case 'location':
      return `L:${c.location}`;
    case 'industry':
      return `I:${[...c.industries].sort().join('+')}`;
    default:
      return c.kind;
  }
}

/** 我方状态 → 可比对面（与对方 StateMirror 同构，牌转牌面字符串）。 */
function comparable(state: GameState): unknown {
  const consumed: Record<string, number> = {};
  for (const ind of ['cotton', 'manufacturer', 'pottery', 'coal', 'iron', 'brewery'] as IndustryType[]) {
    let total = 0;
    for (let level = 1; level <= 8; level++) total += tileDef(ind, level)?.count ?? 0;
    consumed[ind] = total;
  }
  const slotRep = (t: { tile: TileDef; player: number; flipped: boolean; resources: number } | null) =>
    t ? `${t.tile.industry}L${t.tile.level}@P${t.player}${t.flipped ? 'F' : ''}r${t.resources}` : null;
  return {
    era: state.era,
    round: state.round,
    turnOrder: state.turnOrder,
    currentPlayerIdx: state.currentPlayerIdx,
    actionsThisTurn: state.actionsThisTurn,
    players: state.players.map((p) => ({
      money: p.money,
      incomeSpace: p.incomeSpace,
      vp: p.vp,
      hand: p.hand.map(cardFace),
      tilesLeft: {
        cotton: p.tiles.filter((t) => t.industry === 'cotton').length,
        manufacturer: p.tiles.filter((t) => t.industry === 'manufacturer').length,
        pottery: p.tiles.filter((t) => t.industry === 'pottery').length,
        coal: p.tiles.filter((t) => t.industry === 'coal').length,
        iron: p.tiles.filter((t) => t.industry === 'iron').length,
        brewery: p.tiles.filter((t) => t.industry === 'brewery').length,
      },
      spent: p.spentThisRound,
    })),
    slots: Object.fromEntries(
      Object.entries(state.board.slots).map(([loc, arr]) => [loc, arr.map(slotRep)]),
    ),
    links: state.board.links
      .map((l) => `${l.linkIndex}@P${l.player}${l.era}`)
      .sort(),
    coalMarket: state.coalMarket,
    ironMarket: state.ironMarket,
    merchants: Object.fromEntries(
      Object.entries(state.merchants).map(([id, m]) => [
        id,
        m.tiles.map((t, i) => `${t}${m.barrels[i] ? '+beer' : ''}`),
      ]),
    ),
    deck: state.deck.map(cardFace),
    discard: state.discard.map(cardFace).sort(),
    wild: state.wildSupply,
  };
}

/** 对方快照 → 可比对面。 */
function theirComparable(their: TheirState): unknown {
  const theirCardFace = (c: TheirCard): string => {
    if (c === 'WildLocation') return 'wild-location';
    if (c === 'WildIndustry') return 'wild-industry';
    if (typeof c === 'object' && 'Location' in c) return `L:${LOC_MAP[c.Location]}`;
    if (typeof c === 'object' && 'Industry' in c) {
      return `I:${c.Industry.industries.slice(0, c.Industry.n).map((x) => IND_MAP[x]).sort().join('+')}`;
    }
    throw new Error('bad card');
  };
  const slotRep = (t: TheirTile | null) =>
    t ? `${IND_MAP[t.ind]}L${t.def.level}@P${t.player}${t.flipped ? 'F' : ''}r${t.resource_cubes}` : null;
  const slots: Record<string, (string | null)[]> = {};
  for (const [i, c] of CITY_ORDER.entries()) {
    const off = CITY_OFFSETS[i]!;
    slots[c.id] = [];
    for (let s = 0; s < c.slots; s++) slots[c.id]!.push(slotRep(their.city_tiles[off + s] ?? null));
  }
  slots['farm-north'] = [slotRep(their.farm_tiles[0] ?? null)];
  slots['farm-south'] = [slotRep(their.farm_tiles[1] ?? null)];
  const merchants: Record<string, string[]> = {
    shrewsbury: [], gloucester: [], oxford: [], warrington: [], nottingham: [],
  };
  for (const m of their.merchants) {
    const tile =
      m.buys === 'Blank' ? 'blank' : m.buys === 'Any' ? 'any' : IND_MAP[(m.buys as { Industry: string }).Industry]!;
    merchants[LOC_MAP[m.loc]!]!.push(`${tile}${m.has_beer ? '+beer' : ''}`);
  }
  const total = (ind: IndustryType) => {
    let n = 0;
    for (let level = 1; level <= 8; level++) n += tileDef(ind, level)?.count ?? 0;
    return n;
  };
  return {
    era: their.era === 'Canal' ? 'canal' : 'rail',
    round: their.round,
    turnOrder: their.turn_order,
    currentPlayerIdx: their.current_index,
    actionsThisTurn: their.actions_this_turn,
    players: their.players.map((p) => ({
      money: p.money,
      incomeSpace: p.income_space,
      vp: p.vp,
      hand: p.hand.map(theirCardFace),
      tilesLeft: Object.fromEntries(
        THEIR_INDUSTRY_ORDER.map((ind, k) => [ind, total(ind) - (p.industry_next[k] ?? 0)]),
      ),
      spent: their.money_spent_this_round[their.players.indexOf(p)] ?? 0,
    })),
    slots,
    links: their.links
      .map((l, i) => (l ? `${i}@P${l.player}${l.is_canal ? 'canal' : 'rail'}` : null))
      .filter(Boolean)
      .sort(),
    coalMarket: their.coal_market,
    ironMarket: their.iron_market,
    merchants,
    deck: their.deck.slice().reverse().map(theirCardFace),
    discard: their.discard_pile.map(theirCardFace).sort(),
    wild: { location: their.wild_location_pile, industry: their.wild_industry_pile },
  };
}

/** 深度对比（对象键序无关），返回第一个差异路径（无差异返回 null）。 */
function firstDiff(a: unknown, b: unknown, path = ''): string | null {
  const prim = (x: unknown) => x === null || typeof x !== 'object';
  if (prim(a) || prim(b)) {
    return JSON.stringify(a) === JSON.stringify(b)
      ? null
      : `${path}: 我方 ${JSON.stringify(a)} vs 对方 ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    const d = firstDiff(ao[k], bo[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 重放
// ---------------------------------------------------------------------------

/** 商人桶槽位自由选择的安全同步：tiles 相同且总桶数相同、仅桶位不同 → 以对方为准。 */
function syncMerchantBarrelSlots(state: GameState, after: TheirState): GameState {
  const theirMerchants: Record<string, boolean[]> = {
    shrewsbury: [], gloucester: [], oxford: [], warrington: [], nottingham: [],
  };
  for (const m of after.merchants) {
    theirMerchants[LOC_MAP[m.loc]!]!.push(m.has_beer);
  }
  const merchants = { ...state.merchants };
  for (const id of Object.keys(merchants) as MerchantId[]) {
    const ours = merchants[id];
    const theirs = theirMerchants[id]!;
    if (ours.barrels.length !== theirs.length) return state; // 结构不符 → 交给对比报错
    const totalOurs = ours.barrels.filter(Boolean).length;
    const totalTheirs = theirs.filter(Boolean).length;
    if (totalOurs !== totalTheirs) return state;
    if (ours.barrels.every((b, i) => b === theirs[i])) continue;
    merchants[id] = { ...ours, barrels: theirs };
  }
  return { ...state, merchants };
}

let readTrace: Trace;

function syncFromRail(state: GameState, rail: TheirState): GameState {
  // 牌身份跨时代不可延续（两边 RNG 不同）：手牌/牌堆/弃牌/wild 以对方快照为准重新铸造
  cardCounter = 0;
  const synced = mapState(rail, state.playerCount);
  // 保留我方引擎结算出的盘面，仅覆盖牌相关与回合结构字段，并逐项对比其余
  const diffs: string[] = [];
  for (let i = 0; i < state.playerCount; i++) {
    const a = state.players[i]!;
    const b = synced.players[i]!;
    if (a.vp !== b.vp) diffs.push(`P${i} vp ${a.vp}→${b.vp}`);
    if (a.money !== b.money) diffs.push(`P${i} money ${a.money}→${b.money}`);
    if (a.incomeSpace !== b.incomeSpace) diffs.push(`P${i} incomeSpace ${a.incomeSpace}→${b.incomeSpace}`);
  }
  if (JSON.stringify(state.board.slots) !== JSON.stringify(synced.board.slots)) diffs.push('board.slots 不一致');
  if (JSON.stringify(state.merchants) !== JSON.stringify(synced.merchants)) diffs.push('merchants 不一致');
  if (state.turnOrder.join() !== synced.turnOrder.join()) diffs.push(`turnOrder ${state.turnOrder}→${synced.turnOrder}`);
  if (diffs.length > 0) console.log(`  [时代切换对比] ${diffs.join('; ')}`);
  else console.log('  [时代切换对比] 盘面/分数/顺位完全一致 ✓');
  return {
    ...state,
    round: synced.round,
    players: state.players.map((p, i) => ({
      ...p,
      hand: synced.players[i]!.hand,
      tiles: synced.players[i]!.tiles,
    })),
    deck: synced.deck,
    discard: synced.discard,
    wildSupply: synced.wildSupply,
    turnOrder: synced.turnOrder,
    currentPlayerIdx: synced.currentPlayerIdx,
    actionsThisTurn: synced.actionsThisTurn,
  };
}

function replay(path: string): void {
  readTrace = JSON.parse(readFileSync(path, 'utf8')) as Trace;
  const trace = readTrace;
  cardCounter = 0;
  let state = mapState(trace.initial, trace.players as 2 | 3 | 4);
  let railSynced = false;
  let prevAfter: TheirState | null = null;
  for (const [step, { player, mv, after }] of trace.moves.entries()) {
    const preState = state;
    const cur = state.turnOrder[state.currentPlayerIdx]!;
    if (Number(process.env.DEBUG_STEP) === step) {
      console.log('DEBUG pre-state:');
      console.log('  cannock:', JSON.stringify(state.board.slots['cannock']));
      console.log('  手牌:', JSON.stringify(state.players[player]!.hand));
      for (const [i, p] of state.players.entries()) {
        const coal = p.tiles.filter((t) => t.industry === 'coal');
        console.log(`  P${i} coal 栈顶: ${coal[0] ? `L${coal[0].level} (余${coal.length})` : '空'} money=${p.money} incomeSpace=${p.incomeSpace} vp=${p.vp}`);
      }
      console.log('  对方 after cannock:', JSON.stringify(after.city_tiles.slice(19, 21)));
    }
    if (cur !== player) {
      console.log(`✗ step ${step}: 行动者错位 我方当前 P${cur} ≠ 轨迹 P${player} (era=${state.era} round=${state.round})`);
      return;
    }
    const legal = enumerateActions(state, player);
    let action: Action | null;
    try {
      action = findMatch(state, player, mv, legal);
    } catch (e) {
      console.log(`✗ step ${step}: 匹配/构造行动异常: ${e}`);
      return;
    }
    if (!action) {
      console.log(`✗ step ${step}: 找不到匹配行动 (era=${state.era} round=${state.round} P${player})`);
      console.log(`  轨迹: ${JSON.stringify(mv)}`);
      console.log(`  手牌: ${JSON.stringify(state.players[player]!.hand)}`);
      const kind = mv.kind as string;
      const sameType = legal.filter((a) =>
        kind === 'network-double'
          ? a.type === 'network' && a.links.length === 2
          : kind === 'network'
            ? a.type === 'network' && a.links.length === 1
            : a.type === kind,
      );
      console.log(`  我方同类合法(${sameType.length}): ${JSON.stringify(sameType.slice(0, 10))}`);
      return;
    }
    try {
      state = applyAction(state, action);
    } catch (e) {
      console.log(`✗ step ${step}: applyAction 失败 (era=${state.era} round=${state.round} P${player}, ${mv.kind}): ${e}`);
      console.log(`  轨迹: ${JSON.stringify(mv)}`);
      console.log(`  构造: ${JSON.stringify(action)}`);
      return;
    }
    if (state.era === 'rail' && !railSynced && trace.rail) {
      railSynced = true;
      // 分解时代清算：我方 link/产业得分 vs 对方实际 VP 增量
      const linkScored = scoreEraLinks(preState);
      const tileScored = scoreFlippedIndustries(linkScored);
      for (let i = 0; i < state.playerCount; i++) {
        const ourLink = linkScored.players[i]!.vp - preState.players[i]!.vp;
        const ourTile = tileScored.players[i]!.vp - linkScored.players[i]!.vp;
        const theirGain = trace.rail.players[i]!.vp - prevAfter!.players[i]!.vp;
        console.log(
          `  [时代清算] P${i} 我方 link+${ourLink} 产业+${ourTile}（共 +${ourLink + ourTile}）vs 对方 +${theirGain}`,
        );
      }
      state = syncFromRail(state, trace.rail);
    }
    state = syncMerchantBarrelSlots(state, after);
    // 终局态的回合结构字段（顺位/当前玩家/行动计数/轮数）两边语义不同；
    // 对方引擎终局不移除 Link（仅展示残留），均不对比
    const strip = (o: unknown): unknown => {
      if (state.phase !== 'game-over') return o;
      const c = { ...(o as Record<string, unknown>) };
      for (const k of ['turnOrder', 'currentPlayerIdx', 'actionsThisTurn', 'round', 'links']) {
        delete c[k];
      }
      return c;
    };
    const diff = firstDiff(
      strip(comparable(state)),
      strip(theirComparable(after)),
    );
    if (diff) {
      console.log(`✗ step ${step}: 行动后状态分歧 (era=${state.era} round=${state.round} P${player}, ${mv.kind})`);
      console.log(`  轨迹: ${JSON.stringify(mv)}`);
      console.log(`  首个差异: ${diff}`);
      if (process.env.DEBUG_FULL) {
        console.log('  我方 players:', JSON.stringify((comparable(state) as { players: unknown }).players));
        console.log('  对方 players:', JSON.stringify((theirComparable(after) as { players: unknown }).players));
      }
      return;
    }
    prevAfter = after;
  }
  if (state.phase !== 'game-over') {
    console.log(`✗ 重放结束但未终局 (phase=${state.phase} era=${state.era} round=${state.round})`);
    return;
  }
  const ours = state.players.map((p) => p.vp);
  const okVp = ours.every((v, i) => v === trace.final_vps[i]);
  const okInc = state.players.every((p, i) => p.incomeSpace === trace.final_income_spaces[i]);
  const okMoney = state.players.every((p, i) => p.money === trace.final_money[i]);
  console.log(
    `${okVp && okInc && okMoney ? '✓' : '✗'} ${path}\n  VP 我方 ${ours.join('/')} vs 对方 ${trace.final_vps.join('/')}` +
      `${okInc ? '' : `\n  incomeSpace 我方 ${state.players.map((p) => p.incomeSpace).join('/')} vs 对方 ${trace.final_income_spaces.join('/')}`}` +
      `${okMoney ? '' : `\n  money 我方 ${state.players.map((p) => p.money).join('/')} vs 对方 ${trace.final_money.join('/')}`}`,
  );
}

for (const path of process.argv.slice(2)) replay(path);
