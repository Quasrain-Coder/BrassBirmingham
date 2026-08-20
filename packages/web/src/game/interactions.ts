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
import { LINKS, LOCATIONS } from '@brass/engine';
import type { Action, Card, IndustryType, LocationId, PlayerIndex } from '@brass/engine';
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
      return '侦察：弃 3 张换百搭·城市 + 百搭·产业';
    case 'pass':
      return '过';
  }
}
