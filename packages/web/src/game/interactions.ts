/**
 * 行动交互纯函数（M2 Task 11）：legalActions → 可点目标映射 + 参数逐步收窄匹配。
 *
 * 核心不变量：所有 match* 函数返回入参 legalActions/candidates 数组里的**同一个
 * Action 对象**（绝不新构造）——engine 对 scout cardIds 做有序逐元素比较、sell 只
 * 枚举"单块/全集"，新构造的 Action 会被判 illegal-action。参数收集 = 逐步缩小
 * legalActions 子集，最后取唯一匹配项。
 *
 * 枚举形态假设（均有真实枚举 fixture 测试背书，见 interactions.test.ts）：
 * - scout：手牌全部 C(n,3) 组合，cardIds 按手牌下标 i<j<k 升序——用户乱序选 3 张后
 *   按手牌序排序再匹配。
 * - develop：removals 按产业规范化序（INDUSTRY_ORDER）升序——用户乱序选后排序匹配。
 * - network：双轨 links 为有序对（放置顺序），两种顺序分别枚举——点击顺序即放置顺序。
 * - sell：单块全枚举 + "可卖全集"至多一个（sales.length >= 2）。
 */
import { LINKS, LOCATIONS, MERCHANTS, reachableFrom } from '@brass/engine';
import type {
  Action,
  BeerSourceRef,
  Card,
  IndustryType,
  LocationId,
  MerchantId,
  PlayerIndex,
} from '@brass/engine';
import type { FilteredState } from '@brass/protocol';
import type { SlotRef } from '../board/BoardSvg';
import {
  industryName,
  locationName as displayLocationName,
  merchantName,
  nodeName,
} from './display';

export type BuildAction = Extract<Action, { type: 'build' }>;
export type NetworkAction = Extract<Action, { type: 'network' }>;
export type DevelopAction = Extract<Action, { type: 'develop' }>;
export type SellAction = Extract<Action, { type: 'sell' }>;

/** 产业规范化顺序（与 engine develop.ts / sell.ts 的 INDUSTRY_ORDER 一致）。 */
export const INDUSTRY_ORDER: readonly IndustryType[] = [
  'cotton',
  'manufacturer',
  'pottery',
  'coal',
  'iron',
  'brewery',
];

function industryRank(ind: IndustryType): number {
  return INDUSTRY_ORDER.indexOf(ind);
}

/** 选中手牌后的候选子集；scout 无 cardId 字段，按 cardIds 包含匹配。 */
export function actionsForCard(legalActions: readonly Action[], cardId: string): Action[] {
  return legalActions.filter((a) =>
    a.type === 'scout' ? a.cardIds.includes(cardId) : a.cardId === cardId,
  );
}

export interface ActionTargets {
  /** build 目标城市 + sell 板块所在城市。 */
  locations: Set<LocationId>;
  /** network 候选涉及的全部边下标。 */
  links: Set<number>;
  /** build：城市 → 可建产业（去重，按规范化序）。 */
  industries: Map<LocationId, IndustryType[]>;
}

/** 选中手牌后棋盘上可点目标（build/sell 城市、network 边、build 各城市产业）。 */
export function targetsFor(
  selectedCard: string | null,
  legalActions: readonly Action[],
): ActionTargets {
  const targets: ActionTargets = {
    locations: new Set(),
    links: new Set(),
    industries: new Map(),
  };
  if (selectedCard === null) return targets;
  for (const a of actionsForCard(legalActions, selectedCard)) {
    switch (a.type) {
      case 'build': {
        targets.locations.add(a.location);
        const list = targets.industries.get(a.location) ?? [];
        if (!list.includes(a.industry)) {
          list.push(a.industry);
          list.sort((x, y) => industryRank(x) - industryRank(y));
          targets.industries.set(a.location, list);
        }
        break;
      }
      case 'network':
        for (const l of a.links) targets.links.add(l);
        break;
      case 'sell':
        for (const s of a.sales) targets.locations.add(s.location);
        break;
      default:
        break;
    }
  }
  return targets;
}

type BoardSlots = FilteredState['board']['slots'];

/**
 * build 目标展开到槽位：城市内印刷产业命中且**仍为空**的槽位。
 * （engine 保证 (location, industry) 对全合法，具体槽位由 engine 定；此处只做高亮。）
 */
export function buildSlotTargets(targets: ActionTargets, boardSlots: BoardSlots): SlotRef[] {
  const out: SlotRef[] = [];
  for (const [location, industries] of targets.industries) {
    const def = LOCATIONS[location];
    const slots = boardSlots[location];
    if (!def || !slots) continue;
    def.slots.forEach((slot, slotIndex) => {
      if (slots[slotIndex] !== null && slots[slotIndex] !== undefined) return;
      if (slot.industries.some((ind) => industries.includes(ind))) {
        out.push({ location, slotIndex });
      }
    });
  }
  return out;
}

/** sell 高亮槽位：直接取候选 sales 的 (location, slotIndex)（去重）。 */
export function sellSlotTargets(candidates: readonly Action[]): SlotRef[] {
  const seen = new Set<string>();
  const out: SlotRef[] = [];
  for (const a of candidates) {
    if (a.type !== 'sell') continue;
    for (const s of a.sales) {
      const key = `${s.location}${s.slotIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ location: s.location, slotIndex: s.slotIndex });
    }
  }
  return out;
}

/** 点击槽位后的 build 候选：行动城市一致且槽位印刷产业包含行动产业。 */
export function buildCandidatesAt(
  candidates: readonly Action[],
  location: LocationId,
  slotIndex: number,
): BuildAction[] {
  const slot = LOCATIONS[location]?.slots[slotIndex];
  if (!slot) return [];
  return candidates.filter(
    (a): a is BuildAction =>
      a.type === 'build' && a.location === location && slot.industries.includes(a.industry),
  );
}

/**
 * 引擎 resolveSlot 的客户端复刻(build.ts 同一规范化):预览落槽必须与实际结算一致——
 * ①对手煤/铁厂 overbuild(全图含市场该类方块为 0,运河时代同地有己方板块时禁)
 * ②空槽:先单图标槽、后双图标槽(官方槽位序;运河时代同地有己方板块时禁新增)
 * ③己方 overbuild:同产业等级最低(并列槽位序)
 * 规则书 p.9:"If possible, place it on a space displaying only that industry's icon."
 */
export function resolveBuildSlot(
  state: FilteredState,
  player: PlayerIndex,
  location: LocationId,
  industry: IndustryType,
  defLevel: number,
): SlotRef | null {
  const slotDefs = LOCATIONS[location]?.slots;
  const placed = state.board.slots[location];
  if (!slotDefs || !placed) return null;

  const canalBlocked =
    state.era === 'canal' && placed.some((t) => t !== null && t.player === player);

  const globalCubes = (ind: 'coal' | 'iron'): number => {
    let n = ind === 'coal' ? state.coalMarket : state.ironMarket;
    for (const slots of Object.values(state.board.slots)) {
      for (const t of slots) {
        if (t && t.tile.industry === ind) n += t.resources;
      }
    }
    return n;
  };

  // 1. 对手 overbuild
  if (!canalBlocked && (industry === 'coal' || industry === 'iron') && globalCubes(industry) === 0) {
    for (let i = 0; i < slotDefs.length; i++) {
      if (!slotDefs[i]!.industries.includes(industry)) continue;
      const t = placed[i];
      if (t && t.player !== player && t.tile.industry === industry && t.tile.level < defLevel) {
        return { location, slotIndex: i };
      }
    }
  }

  // 2. 空槽:先单图标,后双图标
  if (!canalBlocked) {
    for (const dual of [false, true]) {
      for (let i = 0; i < slotDefs.length; i++) {
        const sd = slotDefs[i]!;
        if ((sd.industries.length === 2) !== dual) continue;
        if (!sd.industries.includes(industry)) continue;
        if (placed[i] === null) return { location, slotIndex: i };
      }
    }
  }

  // 3. 己方 overbuild:同产业、等级严格更低;多块取等级最低(并列槽位序)
  let best: { slotIndex: number; level: number } | null = null;
  for (let i = 0; i < slotDefs.length; i++) {
    if (!slotDefs[i]!.industries.includes(industry)) continue;
    const t = placed[i];
    if (!t || t.player !== player || t.tile.industry !== industry || t.tile.level >= defLevel) {
      continue;
    }
    if (!best || t.tile.level < best.level) best = { slotIndex: i, level: t.tile.level };
  }
  if (best) return { location, slotIndex: best.slotIndex };
  return null;
}

/** 点击槽位后的 sell 单卖候选：sales[0] 对应该槽位（单卖 sales 长度恒为 1）。 */
export function sellCandidatesAt(
  candidates: readonly Action[],
  location: LocationId,
  slotIndex: number,
): SellAction[] {
  return candidates.filter(
    (a): a is SellAction =>
      a.type === 'sell' &&
      a.sales.length === 1 &&
      a.sales[0]?.location === location &&
      a.sales[0]?.slotIndex === slotIndex,
  );
}

export interface NetworkMatch {
  /** 与已点序列完全相等的唯一候选（无则 null）。 */
  exact: NetworkAction | null;
  /** 是否存在以已点序列为前缀的更长候选（可继续点第二条）。 */
  canExtend: boolean;
  /** 已点序列是否仍是某候选的前缀（无效点击不应入序列）。 */
  valid: boolean;
}

function linksStartWith(a: NetworkAction, prefix: readonly number[]): boolean {
  return (
    a.links.length >= prefix.length && prefix.every((v, k) => a.links[k] === v)
  );
}

/** network 序列匹配：点击顺序 = 放置顺序（双轨有序对）。 */
export function matchNetwork(
  candidates: readonly Action[],
  picked: readonly number[],
): NetworkMatch {
  const nets = candidates.filter((a): a is NetworkAction => a.type === 'network');
  const withPrefix = nets.filter((a) => linksStartWith(a, picked));
  const exact = withPrefix.find((a) => a.links.length === picked.length) ?? null;
  return {
    exact,
    canExtend: withPrefix.some((a) => a.links.length > picked.length),
    valid: withPrefix.length > 0,
  };
}

/** 当前可继续点的边集合（network 高亮用；picked 为空时为所有候选首边）。 */
export function extendableLinks(
  candidates: readonly Action[],
  picked: readonly number[],
): Set<number> {
  const out = new Set<number>();
  for (const a of candidates) {
    if (a.type !== 'network') continue;
    if (!linksStartWith(a, picked)) continue;
    const next = a.links[picked.length];
    if (next !== undefined) out.add(next);
  }
  return out;
}

/** develop 可选产业：出现在任一候选 removals 中，按规范化序。 */
export function developOptions(candidates: readonly Action[]): IndustryType[] {
  const seen = new Set<IndustryType>();
  for (const a of candidates) {
    if (a.type !== 'develop') continue;
    for (const ind of a.removals) seen.add(ind);
  }
  return INDUSTRY_ORDER.filter((ind) => seen.has(ind));
}

/** 同产业双研发可选的产业：存在 [x, x] 候选（engine develop.ts doubleSameIndustryOk）。 */
export function developDoubles(candidates: readonly Action[]): Set<IndustryType> {
  const out = new Set<IndustryType>();
  for (const a of candidates) {
    if (a.type !== 'develop') continue;
    const [r0, r1] = a.removals;
    if (a.removals.length === 2 && r0 !== undefined && r0 === r1) out.add(r0);
  }
  return out;
}

/** removals 规范化排序（INDUSTRY_ORDER 升序；同产业双块保持相邻）。 */
export function normalizeRemovals(picks: readonly IndustryType[]): IndustryType[] {
  return [...picks].sort((x, y) => industryRank(x) - industryRank(y));
}

/** develop 精确匹配：规范化后逐元素相等，返回候选数组中的原对象。 */
export function matchDevelop(
  candidates: readonly Action[],
  picks: readonly IndustryType[],
): DevelopAction | null {
  if (picks.length === 0) return null;
  const want = normalizeRemovals(picks);
  return (
    candidates.filter((a): a is DevelopAction => a.type === 'develop').find(
      (a) => a.removals.length === want.length && a.removals.every((v, k) => v === want[k]),
    ) ?? null
  );
}

export interface SellOptions {
  /** 单块销售全枚举（板块 × 商人位 × useMerchantBeer）。 */
  singles: SellAction[];
  /** "可卖全集"多块行动（枚举至多一个，sales.length >= 2）。 */
  fullSet: SellAction | null;
}

export function sellOptions(candidates: readonly Action[]): SellOptions {
  const singles: SellAction[] = [];
  let fullSet: SellAction | null = null;
  for (const a of candidates) {
    if (a.type !== 'sell') continue;
    if (a.sales.length === 1) singles.push(a);
    else fullSet = a;
  }
  return { singles, fullSet };
}

/**
 * scout 匹配：用户任意顺序选 3 张 → 按手牌下标升序（枚举的 i<j<k 序）排序后
 * 逐元素相等匹配，返回 legalActions 中的原对象。不足 3 张或含非手牌 id 返回 null。
 */
export function matchScout(
  legalActions: readonly Action[],
  hand: readonly Card[],
  pickedIds: readonly string[],
): Action | null {
  if (pickedIds.length !== 3) return null;
  const indexOf = new Map(hand.map((c, i) => [c.id, i] as const));
  const indices: number[] = [];
  for (const id of pickedIds) {
    const i = indexOf.get(id);
    if (i === undefined) return null;
    indices.push(i);
  }
  indices.sort((a, b) => a - b);
  const want = indices.map((i) => hand[i]!.id);
  return (
    legalActions.find(
      (a) => a.type === 'scout' && a.cardIds.every((v, k) => v === want[k]),
    ) ?? null
  );
}

/** 城市显示名（未知 id 原样）。 */
function locationName(location: string): string {
  return displayLocationName(location);
}

/** 连接边一句话：两端点名（含商人位中文名）。 */
function linkName(linkIndex: number): string {
  const l = LINKS[linkIndex];
  if (!l) return `#${linkIndex}`;
  return `${nodeName(l.a)}—${nodeName(l.b)}`;
}

/** 行动一句话描述（ActionBar 确认区 / 待选列表）。 */
export function describeAction(action: Action): string {
  switch (action.type) {
    case 'build':
      return `建造 ${industryName(action.industry)} @ ${locationName(action.location)}`;
    case 'network':
      return `连接 ${action.links.map(linkName).join(' + ')}`;
    case 'develop':
      return `研发移除 ${action.removals.map(industryName).join(' + ')}`;
    case 'sell':
      return `出售 ×${action.sales.length}：${action.sales
        .map(
          (s) =>
            `${locationName(s.location)}→${merchantName(s.merchant)}${s.useMerchantBeer ? '（用商人啤酒）' : ''}`,
        )
        .join('，')}`;
    case 'loan':
      return '贷款 £30（收入 −3 级）';
    case 'scout':
      return '搜寻：弃 3 张换百搭·城市 + 百搭·产业';
    case 'pass':
      return '过';
  }
}

/**
 * 各产业当前可建性标注（玩家面板明细行用,brassforge 同款"✓ 可建造/缺……"）:
 * - 板块已用尽:该产业面板堆叠已空;
 * - ✓ 可建造:legalActions 中存在该产业的 build(已有可用的牌+资源+槽位);
 * - 还需 £N:面板顶板块现金成本超过当前现金;
 * - 暂不可建:其余(无匹配空槽/不在网络内/缺煤铁——精确归因需引擎支持,先给兜底)。
 */
export function buildabilityFor(
  state: FilteredState,
  seat: PlayerIndex,
  legalActions: readonly Action[],
): Partial<Record<IndustryType, string>> {
  const self = state.players[seat];
  if (self === undefined) return {};
  const out: Partial<Record<IndustryType, string>> = {};
  for (const ind of INDUSTRY_ORDER) {
    const top = self.tiles.find((t) => t.industry === ind);
    if (top === undefined) {
      out[ind] = '板块已用尽';
      continue;
    }
    if (legalActions.some((a) => a.type === 'build' && a.industry === ind)) {
      out[ind] = '✓ 可建造';
      continue;
    }
    if (top.costMoney > self.money) {
      out[ind] = `还需 £${top.costMoney - self.money}`;
      continue;
    }
    out[ind] = '暂不可建';
  }
  return out;
}

/**
 * 显式槽位选择（bug2）：同地没有可放该产业的**空单图标槽**时，允许玩家在空双图标
 * 槽之间自选（与 engine applyBuild 的 illegal-build-slot 校验同规则；单图标槽优先
 * 仍强制）。返回应附到 build Action 的 slotIndex；无需/不可显式时返回 undefined。
 */
export function explicitBuildSlot(
  state: FilteredState,
  seat: PlayerIndex,
  action: BuildAction,
  clicked: SlotRef,
): number | undefined {
  if (clicked.location !== action.location) return undefined;
  const def = state.players[seat]?.tiles.find((t) => t.industry === action.industry);
  if (def === undefined) return undefined;
  const resolved = resolveBuildSlot(state, seat, action.location, action.industry, def.level);
  // 点击的已是规范化落槽 → 无需显式
  if (resolved === null || resolved.slotIndex === clicked.slotIndex) return undefined;
  const slotDefs = LOCATIONS[action.location]?.slots;
  const placed = state.board.slots[action.location];
  if (!slotDefs || !placed) return undefined;
  // 规范化落点须为空槽放置（overbuild 情形不允许显式改槽）
  if (placed[resolved.slotIndex] !== null) return undefined;
  // 点击槽须为空且接收该产业
  const clickedDef = slotDefs[clicked.slotIndex];
  if (clickedDef === undefined || !clickedDef.industries.includes(action.industry)) return undefined;
  if (placed[clicked.slotIndex] !== null) return undefined;
  // 单图标槽优先:存在空单图标槽时显式选双图标槽非法
  const singleIconEmpty = slotDefs.some(
    (sd, i) =>
      sd.industries.length === 1 && sd.industries.includes(action.industry) && placed[i] === null,
  );
  if (singleIconEmpty) return undefined;
  return clicked.slotIndex;
}

// ---------------------------------------------------------------------------
// Sell 分组选择器(2026-08-21):建筑 → 贸易商 → 逐桶啤酒源,一组组拼自定义 sales
// ---------------------------------------------------------------------------

export interface SellableTileRef extends SlotRef {
  industry: IndustryType;
  level: number;
  beerToFlip: number;
}

/** 本人场上未翻面的可卖板块(棉/制造/陶),按地点字典序+槽位序。 */
export function sellableTilesFor(state: FilteredState, seat: PlayerIndex): SellableTileRef[] {
  const out: SellableTileRef[] = [];
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (let i = 0; i < slots.length; i++) {
      const t = slots[i];
      if (t && t.player === seat && !t.flipped && t.tile.sellable) {
        out.push({
          location: loc as LocationId,
          slotIndex: i,
          industry: t.tile.industry,
          level: t.tile.level,
          beerToFlip: t.tile.beerToFlip,
        });
      }
    }
  }
  out.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0) || a.slotIndex - b.slotIndex);
  return out;
}

/** 该板块可卖向的商人位:可达(当前时代已建边)且图标匹配('any' 收任意;'blank' 不算)。 */
export function merchantsForTile(state: FilteredState, tile: SlotRef): MerchantId[] {
  const reach = reachableFrom(state as unknown as import('@brass/engine').GameState, [tile.location]);
  const placed = state.board.slots[tile.location]?.[tile.slotIndex];
  if (placed == null) return [];
  return (Object.keys(MERCHANTS) as MerchantId[]).filter((id) => {
    if (!reach.has(id)) return false;
    const m = state.merchants[id];
    return m.tiles.some((t) => t === 'any' || t === placed.tile.industry);
  });
}

export interface BreweryRef extends SlotRef {
  player: PlayerIndex;
  barrels: number;
}

/** 啤酒源候选:商人桶(有桶时至多 1)+ 自家酒厂(无需连通)+ 对手酒厂(须连通用酒处)。 */
export function beerSourcesFor(
  state: FilteredState,
  seat: PlayerIndex,
  merchant: MerchantId,
): { merchantBarrel: boolean; own: BreweryRef[]; opponent: BreweryRef[] } {
  const reach = reachableFrom(state as unknown as import('@brass/engine').GameState, [merchant]);
  const own: BreweryRef[] = [];
  const opponent: BreweryRef[] = [];
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (let i = 0; i < slots.length; i++) {
      const t = slots[i];
      if (!t || t.flipped || t.tile.industry !== 'brewery' || t.resources <= 0) continue;
      const ref: BreweryRef = { location: loc as LocationId, slotIndex: i, player: t.player, barrels: t.resources };
      if (t.player === seat) own.push(ref);
      else if (reach.has(loc as LocationId)) opponent.push(ref);
    }
  }
  return { merchantBarrel: state.merchants[merchant].beer > 0, own, opponent };
}

/** 按已选 beerSources 计算还剩多少桶可用(组内连续消耗同一酒厂不能超过其桶数)。 */
export function beerRemaining(
  sources: { own: BreweryRef[]; opponent: BreweryRef[] },
  picked: BeerSourceRef[],
): Map<string, number> {
  const used = new Map<string, number>();
  for (const p of picked) {
    if (p.kind !== 'brewery') continue;
    const k = `${p.location}:${p.slotIndex}`;
    used.set(k, (used.get(k) ?? 0) + 1);
  }
  const remaining = new Map<string, number>();
  for (const b of [...sources.own, ...sources.opponent]) {
    const k = `${b.location}:${b.slotIndex}`;
    remaining.set(k, b.barrels - (used.get(k) ?? 0));
  }
  return remaining;
}

/**
 * 本时代完整行动日志重建（"行动日志补全"）：eraActions 是按座位分桶的有序行动,
 * 按规则回合结构（运河首轮各 1 动,其余各 2 动,turnOrder 轮转）交错还原全局顺序。
 * resume/重放后客户端 log 只有残尾,用它补全整个时代的日志展示。
 */
export function reconstructEraLog(
  state: FilteredState,
  eraActions: readonly (readonly { action: Action; moneyDelta: number }[])[],
): { player: PlayerIndex; action: Action }[] {
  const out: { player: PlayerIndex; action: Action }[] = [];
  const idx = eraActions.map(() => 0);
  const perRound = (round: number): number => (state.era === 'canal' && round === 1 ? 1 : 2);
  for (let round = 1; ; round += 1) {
    let any = false;
    for (const seat of state.turnOrder) {
      for (let k = 0; k < perRound(round); k += 1) {
        const e = eraActions[seat]?.[idx[seat]!];
        if (e === undefined) break;
        out.push({ player: seat, action: e.action });
        idx[seat]! += 1;
        any = true;
      }
    }
    if (!any) break;
  }
  return out;
}

/**
 * 该板块当前真能卖向的商人位(可达+图标收货+啤酒总量够)——
 * 卖出高亮(选板块后圈出这些贸易商)与细节行共用同一份判定。
 */
export function feasibleSellMerchants(
  state: FilteredState,
  seat: PlayerIndex,
  tile: SlotRef,
  beerToFlip: number,
): MerchantId[] {
  return merchantsForTile(state, tile).filter((id) => {
    const src = beerSourcesFor(state, seat, id);
    const total =
      (src.merchantBarrel ? 1 : 0) +
      src.own.reduce((s, b) => s + b.barrels, 0) +
      src.opponent.reduce((s, b) => s + b.barrels, 0);
    return total >= beerToFlip;
  });
}
