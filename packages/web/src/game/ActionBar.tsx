/**
 * 行动交互层（M2 Task 11）：useActionDraft 参数收集状态机 + ActionBar 展示组件。
 *
 * 核心规则：**提交的行动必须是 legalActions 中匹配到的条目本身**（draft.resolved 恒为
 * 入参数组原对象，由测试断言 toContain），绝不新构造 Action——engine 对 scout cardIds
 * 有序逐元素比较、sell 只枚举单块/全集。**唯一例外**：build 的显式槽位选择
 * （双-双图标槽自由选,bug2）会附 slotIndex 产生新对象——engine 按内容重新校验
 * （三元组合法 + illegal-build-slot 槽位规则），不依赖引用相等。
 * 参数收集 = 逐步缩小 legalActions 子集：
 * - build：点棋盘槽位 → buildCandidatesAt（多产业槽歧义时列出待选）
 * - network：按放置顺序点边（双轨有序对），matchNetwork 前缀收窄；点末条撤销
 * - develop：点 1-2 个产业按钮，normalizeRemovals 后精确匹配
 * - sell：单卖按钮逐个列出（点板块槽位可过滤）+ "可卖全集"一键
 * - scout：从手牌选 3 张，matchScout 按手牌序排序匹配 i<j<k 枚举项
 * - loan/pass：无参数，点按钮即暂存待确认
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { Action, BeerSourceRef, Card, IndustryType, LocationId, MerchantId, PlayerIndex } from '@brass/engine';
import type { FilteredState } from '@brass/protocol';
import type { BoardHighlights, SlotRef } from '../board/BoardSvg';
import {
  actionsForCard,
  beerSourcesFor,
  buildCandidatesAt,
  buildSlotTargets,
  describeAction,
  developDoubles,
  developOptions,
  explicitBuildSlot,
  extendableLinks,
  matchDevelop,
  matchNetwork,
  matchScout,
  merchantsForTile,
  resolveBuildSlot,
  sellCandidatesAt,
  sellOptions,
  sellSlotTargets,
  sellableTilesFor,
  targetsFor,
} from './interactions';
import type { BuildAction, SellAction } from './interactions';
import { cardName, industryName, locationName, merchantName } from './display';
import { moneyDelta, previewOf } from './preview';

export interface UseActionDraftArgs {
  legalActions: Action[];
  selectedCard: string | null;
  state: FilteredState;
  seat: PlayerIndex;
}

export interface ActionDraft {
  /** 选中牌过滤后的候选子集。 */
  candidates: Action[];
  /** 棋盘高亮（build 空槽 + sell 板块槽 + network 当前可点边）。 */
  highlights: BoardHighlights;
  pickedLinks: number[];
  networkCanExtend: boolean;
  developPicks: IndustryType[];
  /** develop 可选产业（出现在任一候选中）。 */
  developChoices: IndustryType[];
  scoutPicks: string[];
  scoutAvailable: boolean;
  /** sell 单卖选项（sellTile 过滤后）。 */
  sellSingles: SellAction[];
  sellFullSet: SellAction | null;
  /** 棋盘点选的 sell 板块（过滤单卖列表）。 */
  sellTile: SlotRef | null;
  /** 分组卖出：已完成的组(建筑+贸易商+逐桶啤酒源)。 */
  sellGroups: { tile: SlotRef; merchant: MerchantId; beer: BeerSourceRef[] }[];
  /** 当前组的贸易商与已选啤酒。 */
  sellMerchant: MerchantId | null;
  sellBeer: BeerSourceRef[];
  /** 选/改本组建筑(再点同一板块取消;切换清空贸易商与啤酒)。 */
  pickSellTile: (ref: SlotRef) => void;
  /** 选/改本组贸易商(再点同一商人取消;切换清商人桶)。 */
  pickSellMerchant: (id: MerchantId) => void;
  /** 切换商人桶(至多 1 桶;须先选贸易商)。 */
  toggleSellMerchantBarrel: () => void;
  /** 设定某酒厂已用桶数(0..barrels;点第 i 个桶按钮 = 用 i 桶)。 */
  setSellBreweryCount: (ref: SlotRef, count: number) => void;
  /** 组完整(建筑+贸易商+啤酒够数)时收下本组,开始下一组。 */
  commitSellGroup: () => void;
  removeSellGroup: (i: number) => void;
  /** 图上点贸易商位:未选建筑无效;未选贸易商=选定;同商人再点=切商人桶;不同=换。 */
  clickMerchant: (id: MerchantId) => void;
  /** 槽位歧义（一槽多产业）时的待选 build。 */
  buildChoices: BuildAction[];
  /** 建造预览（非贴合的预览 token 盖在目标槽位，切换城市即跟随）。 */
  buildPreview: { location: LocationId; slotIndex: number; industry: IndustryType } | null;
  /** 建造产业预选（行动行产业按钮）：选中后棋盘高亮/点槽只解析该产业。 */
  buildIndustry: IndustryType | null;
  /** 预选/取消预选建造产业（再次点同一产业 = 取消）。 */
  pickIndustry: (ind: IndustryType) => void;
  /** 啤酒匹配线(resolved 为卖货时):啤酒来源(商人位/自有酒厂)→ 卖货地点。 */
  beerMatches: { from: LocationId | MerchantId; to: LocationId }[];
  /** 唯一匹配到的可提交行动（legalActions 原对象）。 */
  resolved: Action | null;
  clickSlot: (location: LocationId, slotIndex: number) => void;
  clickLink: (linkIndex: number) => void;
  toggleDevelop: (ind: IndustryType) => void;
  toggleScoutCard: (cardId: string) => void;
  /** 显式选定某候选（sell 单卖/全集、build 歧义项、loan/pass）。 */
  choose: (action: Action) => void;
  /** 清空已收集参数（不动选牌——选牌由 store 管）。 */
  reset: () => void;
}

export function useActionDraft({
  legalActions,
  selectedCard,
  state,
  seat,
}: UseActionDraftArgs): ActionDraft {
  const [pickedLinks, setPickedLinks] = useState<number[]>([]);
  const [developPicks, setDevelopPicks] = useState<IndustryType[]>([]);
  const [scoutPicks, setScoutPicks] = useState<string[]>([]);
  const [sellTile, setSellTile] = useState<SlotRef | null>(null);
  const [sellMerchant, setSellMerchant] = useState<MerchantId | null>(null);
  const [sellBeer, setSellBeer] = useState<BeerSourceRef[]>([]);
  const [sellGroups, setSellGroups] = useState<{ tile: SlotRef; merchant: MerchantId; beer: BeerSourceRef[] }[]>([]);
  const [buildChoices, setBuildChoices] = useState<BuildAction[]>([]);
  /** 槽位歧义待选时记住所点槽位(choose 时附显式 slotIndex)。 */
  const [choicesSlot, setChoicesSlot] = useState<SlotRef | null>(null);
  const [buildIndustry, setBuildIndustry] = useState<IndustryType | null>(null);
  const [chosen, setChosen] = useState<Action | null>(null);

  const reset = (): void => {
    setPickedLinks([]);
    setDevelopPicks([]);
    setScoutPicks([]);
    setSellTile(null);
    setSellMerchant(null);
    setSellBeer([]);
    setSellGroups([]);
    setBuildChoices([]);
    setChoicesSlot(null);
    setBuildIndustry(null);
    setChosen(null);
  };

  // 换牌 / 新快照（legalActions 换引用）→ 已收集参数作废
  useEffect(reset, [selectedCard, legalActions]);

  const candidates = useMemo(
    () => (selectedCard === null ? [] : actionsForCard(legalActions, selectedCard)),
    [legalActions, selectedCard],
  );

  const hand = useMemo(() => {
    const h = state.players[seat]?.hand;
    return h?.kind === 'full' ? h.cards : [];
  }, [state, seat]);

  const highlights = useMemo<BoardHighlights>(() => {
    // 已进入卖出选择(选了板块或已有组):去掉建造/连接高亮,只留可卖板块与啤酒源
    const selling = sellTile !== null || sellGroups.length > 0;
    const targets = targetsFor(selectedCard, legalActions);
    let buildSlots = selling ? [] : buildSlotTargets(targets, state.board.slots);
    // 产业预选:高亮只留能落该产业的槽位
    if (buildIndustry !== null) {
      const ind = buildIndustry;
      buildSlots = buildSlots.filter(
        (s) =>
          buildCandidatesAt(candidates, s.location, s.slotIndex).filter(
            (a) => a.industry === ind,
          ).length > 0,
      );
    }
    const slots = [...buildSlots, ...sellSlotTargets(candidates)];
    // 可建城市级高亮:所有可放置地点(与槽位高亮互补,找城更快)
    const locations = [...new Set(buildSlots.map((s) => s.location))];
    // 啤酒源高亮(match 效果):卖货/铁路双轨候选存在时,自己酒厂(无需连通)与有桶商人位
    const needsBeer = candidates.some(
      (a) => a.type === 'sell' || (a.type === 'network' && a.links.length === 2),
    );
    const beerSources: NonNullable<BoardHighlights['beerSources']> = { locations: [], merchants: [] };
    if (needsBeer) {
      for (const [loc, slotsOfLoc] of Object.entries(state.board.slots)) {
        if (
          slotsOfLoc.some(
            (t) => t && t.player === seat && !t.flipped && t.tile.industry === 'brewery' && t.resources > 0,
          )
        ) {
          beerSources.locations!.push(loc as LocationId);
        }
      }
      for (const [mid, m] of Object.entries(state.merchants)) {
        if (m.beer > 0) beerSources.merchants!.push(mid as keyof typeof state.merchants);
      }
    }
    return { slots, links: [...extendableLinks(candidates, pickedLinks)], locations, beerSources };
  }, [selectedCard, legalActions, candidates, state.board.slots, state.merchants, seat, pickedLinks, buildIndustry]);

  const networkMatch = matchNetwork(candidates, pickedLinks);
  const sell = sellOptions(candidates);
  const visibleSellSingles =
    sellTile === null
      ? sell.singles
      : sellCandidatesAt(candidates, sellTile.location, sellTile.slotIndex);

  // 分组卖出拼成的自定义行动:已收组 + 当前组(若已选齐)——选齐任意组确认即亮,
  // 玩家可随时"就卖当前这些";组合式校验,不必命中枚举集
  const sellAction = useMemo((): Action | null => {
    const curPlaced = sellTile !== null ? state.board.slots[sellTile.location]?.[sellTile.slotIndex] : null;
    const currentComplete =
      sellTile !== null && sellMerchant !== null && curPlaced != null && sellBeer.length === curPlaced.tile.beerToFlip;
    if (sellGroups.length === 0 && !currentComplete) return null;
    const cardId = candidates.find((a) => a.type === 'sell')?.cardId ?? selectedCard;
    if (cardId === null) return null;
    const groups = [...sellGroups];
    if (currentComplete && sellTile !== null && sellMerchant !== null) {
      groups.push({ tile: sellTile, merchant: sellMerchant, beer: sellBeer });
    }
    return {
      type: 'sell',
      cardId,
      sales: groups.map((g) => ({
        location: g.tile.location,
        slotIndex: g.tile.slotIndex,
        merchant: g.merchant,
        useMerchantBeer: g.beer.some((b) => b.kind === 'merchant'),
        beerSources: g.beer,
      })),
    };
  }, [sellGroups, sellTile, sellMerchant, sellBeer, candidates, selectedCard, state.board.slots]);

  // resolved 优先级：显式选定 > 槽位歧义待选（阻断）> 分组卖出 > network 序列 > develop > scout。
  // 多类型同时收集了参数时按此序取其一，确认钮文案可见所提交内容。
  const resolved: Action | null =
    chosen ??
    (buildChoices.length > 0
      ? null
      : sellAction ??
        (pickedLinks.length > 0 ? networkMatch.exact : null) ??
        matchDevelop(candidates, developPicks) ??
        matchScout(legalActions, hand, scoutPicks));

  const pickSellTile = (ref: SlotRef): void => {
    setSellTile((prev) =>
      prev !== null && prev.location === ref.location && prev.slotIndex === ref.slotIndex
        ? null
        : ref,
    );
    setSellMerchant(null);
    setSellBeer([]);
  };

  const pickSellMerchant = (id: MerchantId): void => {
    setSellMerchant((prev) => (prev === id ? null : id));
    setSellBeer((prev) => prev.filter((b) => b.kind !== 'merchant'));
  };

  const toggleSellMerchantBarrel = (): void => {
    setSellBeer((prev) =>
      prev.some((b) => b.kind === 'merchant')
        ? prev.filter((b) => b.kind !== 'merchant')
        : [...prev, { kind: 'merchant' }],
    );
  };

  const setSellBreweryCount = (ref: SlotRef, count: number): void => {
    setSellBeer((prev) => {
      const rest = prev.filter(
        (b) => !(b.kind === 'brewery' && b.location === ref.location && b.slotIndex === ref.slotIndex),
      );
      const adds: BeerSourceRef[] = Array.from({ length: Math.max(0, count) }, () => ({
        kind: 'brewery',
        location: ref.location,
        slotIndex: ref.slotIndex,
      }));
      return [...rest, ...adds];
    });
  };

  const commitSellGroup = (): void => {
    if (sellTile === null || sellMerchant === null) return;
    const placed = state.board.slots[sellTile.location]?.[sellTile.slotIndex];
    if (placed == null || sellBeer.length !== placed.tile.beerToFlip) return;
    setSellGroups((prev) => [...prev, { tile: sellTile, merchant: sellMerchant, beer: sellBeer }]);
    setSellTile(null);
    setSellMerchant(null);
    setSellBeer([]);
  };

  const removeSellGroup = (i: number): void => {
    setSellGroups((prev) => prev.filter((_, idx) => idx !== i));
  };

  const clickMerchant = (id: MerchantId): void => {
    if (!candidates.some((a) => a.type === 'sell')) return;
    if (sellTile === null) return; // 顺序约束:先选建筑,否则无效
    if (sellMerchant === null) {
      pickSellMerchant(id);
      return;
    }
    if (sellMerchant === id) toggleSellMerchantBarrel();
    else pickSellMerchant(id);
  };

  const clickSlot = (location: LocationId, slotIndex: number): void => {
    // 卖出流图上点选(顺序约束同按钮行):自己可卖板块 = 选本组建筑;
    // 酒厂 = 加一桶啤酒(须已选建筑+贸易商,先点酒厂无效)
    const placedT = state.board.slots[location]?.[slotIndex];
    const sellFlow = candidates.some((a) => a.type === 'sell');
    if (sellFlow && placedT && !placedT.flipped) {
      if (placedT.player === seat && placedT.tile.sellable) {
        pickSellTile({ location, slotIndex });
        return;
      }
      if (
        placedT.tile.industry === 'brewery' &&
        placedT.resources > 0 &&
        sellTile !== null &&
        sellMerchant !== null
      ) {
        const used = sellBeer.filter(
          (b) => b.kind === 'brewery' && b.location === location && b.slotIndex === slotIndex,
        ).length;
        if (used < placedT.resources) setSellBreweryCount({ location, slotIndex }, used + 1);
        return;
      }
    }
    let builds = buildCandidatesAt(candidates, location, slotIndex);
    // 产业预选:只在该产业内解析(槽位多产业歧义被预选消解)
    if (buildIndustry !== null) {
      builds = builds.filter((a) => a.industry === buildIndustry);
    }
    if (builds.length === 1) {
      const b = builds[0]!;
      // 双-双图标槽:玩家点的就是想建的槽位 → 附显式 slotIndex(engine 校验同规则)
      const explicit = explicitBuildSlot(state, seat, b, { location, slotIndex });
      setChosen(explicit !== undefined ? { ...b, slotIndex: explicit } : b);
      setBuildChoices([]);
      setChoicesSlot(null);
      return;
    }
    if (builds.length > 1) {
      setBuildChoices(builds);
      setChoicesSlot({ location, slotIndex });
      setChosen(null);
      return;
    }
  };

  /** 产业预选切换:再点同一产业取消;切换时清掉槽位歧义与已选 build。 */
  const pickIndustry = (ind: IndustryType): void => {
    setBuildIndustry((prev) => (prev === ind ? null : ind));
    setBuildChoices([]);
    setChoicesSlot(null);
    setChosen((prev) => (prev?.type === 'build' && prev.industry !== ind ? null : prev));
  };

  const clickLink = (linkIndex: number): void => {
    // 点末条 = 撤销
    if (pickedLinks[pickedLinks.length - 1] === linkIndex) {
      setPickedLinks(pickedLinks.slice(0, -1));
      return;
    }
    const next = [...pickedLinks, linkIndex];
    if (matchNetwork(candidates, next).valid) {
      setPickedLinks(next);
    }
  };

  /**
   * develop 点选：0→1→2→0 循环（第 2 次点同产业 = 双研发同产业两块，
   * 仅当 legalActions 含 [x,x] 候选时开放；否则 0→1→0 即原 toggle 语义）。
   */
  const toggleDevelop = (ind: IndustryType): void => {
    setDevelopPicks((prev) => {
      const count = prev.filter((x) => x === ind).length;
      if (count === 0) return prev.length >= 2 ? prev : [...prev, ind];
      if (count === 1) {
        if (developDoubles(candidates).has(ind) && prev.length < 2) return [...prev, ind];
        const i = prev.indexOf(ind);
        return [...prev.slice(0, i), ...prev.slice(i + 1)];
      }
      // count === 2 → 全取消该产业
      return prev.filter((x) => x !== ind);
    });
  };

  const toggleScoutCard = (cardId: string): void => {
    setScoutPicks((prev) => {
      const i = prev.indexOf(cardId);
      if (i >= 0) return [...prev.slice(0, i), ...prev.slice(i + 1)];
      if (prev.length >= 3) return prev; // scout 恰 3 张
      return [...prev, cardId];
    });
  };

  const choose = (action: Action): void => {
    // 槽位歧义待选后选定:同样附显式 slotIndex(若该产业允许双-双自选)
    if (action.type === 'build' && choicesSlot !== null) {
      const explicit = explicitBuildSlot(state, seat, action, choicesSlot);
      setChosen(explicit !== undefined ? { ...action, slotIndex: explicit } : action);
    } else {
      setChosen(action);
    }
    setBuildChoices([]);
    setChoicesSlot(null);
  };

  /** 建造预览:显式槽位直接落所点槽;否则按引擎规范化(单图标槽优先等)。 */
  const buildPreview = useMemo(() => {
    if (chosen?.type !== 'build') return null;
    if (chosen.slotIndex !== undefined) {
      return { location: chosen.location, slotIndex: chosen.slotIndex, industry: chosen.industry };
    }
    const def = state.players[seat]?.tiles.find((t) => t.industry === chosen.industry);
    if (def === undefined) return null;
    const target = resolveBuildSlot(state, seat, chosen.location, chosen.industry, def.level);
    if (target === null) return null;
    return { location: target.location, slotIndex: target.slotIndex, industry: chosen.industry };
  }, [chosen, state, seat]);

  /** 啤酒匹配线:分组卖出按显式来源画(已收组+当前组已选);否则沿用规范化(resolved 为卖货时)。 */
  const beerMatches = useMemo(() => {
    const out: { from: LocationId | MerchantId; to: LocationId }[] = [];
    const pushGroup = (tile: SlotRef, merchant: MerchantId, beer: BeerSourceRef[]): void => {
      for (const b of beer) {
        out.push({ from: b.kind === 'merchant' ? merchant : b.location, to: tile.location });
      }
    };
    for (const g of sellGroups) pushGroup(g.tile, g.merchant, g.beer);
    if (sellTile !== null && sellMerchant !== null) pushGroup(sellTile, sellMerchant, sellBeer);
    if (out.length > 0) return out;
    if (resolved?.type !== 'sell') return [];
    // 与 consumeBeer 规范化同序:自有酒厂按 LocationId 字典序取首个有余量者
    const ownBreweries = Object.entries(state.board.slots)
      .filter(([, slotsOfLoc]) =>
        slotsOfLoc.some(
          (t) => t && t.player === seat && !t.flipped && t.tile.industry === 'brewery' && t.resources > 0,
        ),
      )
      .map(([loc]) => loc as LocationId)
      .sort();
    let ownIdx = 0;
    return resolved.sales.map((sale) => {
      if (sale.useMerchantBeer) {
        return { from: sale.merchant, to: sale.location };
      }
      const from = ownBreweries[Math.min(ownIdx, Math.max(ownBreweries.length - 1, 0))];
      ownIdx += 1;
      return { from: from ?? sale.location, to: sale.location };
    });
  }, [resolved, state.board.slots, seat, sellGroups, sellTile, sellMerchant, sellBeer]);

  return {
    candidates,
    highlights,
    pickedLinks,
    networkCanExtend: networkMatch.canExtend,
    developPicks,
    developChoices: developOptions(candidates),
    scoutPicks,
    scoutAvailable: candidates.some((a) => a.type === 'scout'),
    sellSingles: visibleSellSingles,
    sellFullSet: sell.fullSet,
    sellTile,
    sellGroups,
    sellMerchant,
    sellBeer,
    pickSellTile,
    pickSellMerchant,
    toggleSellMerchantBarrel,
    setSellBreweryCount,
    commitSellGroup,
    removeSellGroup,
    clickMerchant,
    buildChoices,
    buildPreview,
    buildIndustry,
    pickIndustry,
    beerMatches,
    resolved,
    clickSlot,
    clickLink,
    toggleDevelop,
    toggleScoutCard,
    choose,
    reset,
  };
}

export interface ActionBarProps {
  myTurn: boolean;
  /** 当前行动方显示名（非本人时展示"等待 X 行动"）。 */
  waitingFor: string;
  selectedCard: string | null;
  /** 本人手牌（scout 弃牌选择用）。 */
  hand: Card[];
  draft: ActionDraft;
  /** 完整局面（收益预览/啤酒显示用）。 */
  state: FilteredState;
  /** 被扣住待确认的座位（= 本人时显示"结束回合/重置本回合"双按钮）。 */
  turnHold: PlayerIndex | null;
  seat: PlayerIndex;
  /** 本人回合进行中且已行动过(显示"重置本回合"撤回按钮)。 */
  canResetTurn: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onEndTurn: () => void;
  onResetTurn: () => void;
}

export function ActionBar({
  myTurn,
  waitingFor,
  selectedCard,
  hand,
  draft,
  state,
  turnHold,
  seat,
  canResetTurn,
  onConfirm,
  onCancel,
  onEndTurn,
  onResetTurn,
}: ActionBarProps): ReactElement {
  // 现金实时标记:显眼处常驻;暂存行动时预览结算后的现金(取消/重置即恢复)
  const money = state.players[seat]?.money ?? 0;
  const projected =
    draft.resolved !== null ? money + moneyDelta(draft.resolved, state, seat) : null;
  const moneyChip = (showProjection: boolean): ReactElement => (
    <span className="action-money" data-testid="action-money">
      <img className="coin-icon" src="/assets/coins/1.png" alt="" />
      £{money}
      {showProjection && projected !== null && projected !== money ? (
        <span className={`action-money-delta ${projected > money ? 'pos' : 'neg'}`}>
          → £{projected}
        </span>
      ) : null}
    </span>
  );

  // 回合打满待确认:显式"结束回合"放行;"重置本回合"撤销重来
  if (turnHold === seat) {
    return (
      <section className="action-bar turn-hold" data-testid="action-bar">
        <div className="action-bar-head">
          <h3>行动</h3>
          {moneyChip(false)}
        </div>
        <p data-testid="turn-hold-hint">本回合行动已完成。确认后进入下一位玩家;也可以重置本回合重新行动。</p>
        <div className="action-confirm">
          <button type="button" data-testid="end-turn" onClick={onEndTurn}>
            结束回合
          </button>
          <button type="button" data-testid="reset-turn" className="btn-ghost" onClick={onResetTurn}>
            重置本回合
          </button>
        </div>
      </section>
    );
  }
  if (!myTurn) {
    return (
      <section className="action-bar" data-testid="action-bar">
        <div className="action-bar-head">
          <h3>行动</h3>
          {moneyChip(false)}
        </div>
        <p data-testid="waiting" className={turnHold !== null ? 'waiting-hold' : undefined}>
          {turnHold !== null ? `等待 ${waitingFor} 确认回合…` : `等待 ${waitingFor} 行动…`}
        </p>
      </section>
    );
  }

  const builds = draft.candidates.filter((a) => a.type === 'build');
  const networks = draft.candidates.filter((a) => a.type === 'network');
  const sells = draft.candidates.filter((a) => a.type === 'sell');
  const loan = draft.candidates.find((a) => a.type === 'loan');
  const pass = draft.candidates.find((a) => a.type === 'pass');
  // 过:仅当该牌没有任何其他可执行行动时兜底出现(防死锁,例如贷款已不可用)
  const onlyPass =
    draft.candidates.length > 0 && draft.candidates.every((a) => a.type === 'pass');
  // 建造行产业按钮:候选中的产业去重(按候选出现序)
  const buildIndustries = [...new Set(builds.map((a) => a.industry))];

  // 啤酒实况:自己的酒厂桶(无需连通)+ 各商人位余桶
  const ownBreweries = Object.entries(state.board.slots)
    .map(([loc, slotsOfLoc]) => {
      const total = slotsOfLoc
        .filter((t) => t && t.player === seat && !t.flipped && t.tile.industry === 'brewery')
        .reduce((s, t) => s + (t?.resources ?? 0), 0);
      return total > 0 ? `${locationName(loc)}×${total}` : null;
    })
    .filter((x): x is string => x !== null);
  const merchantBeers = Object.entries(state.merchants)
    .filter(([, m]) => m.beer > 0)
    .map(([mid, m]) => `${merchantName(mid)}×${m.beer}`);

  // 不可执行原因提示(项 1/4):选了牌但没有任何建造/卖货目标时,说明原因
  const hasSellableOnBoard = Object.values(state.board.slots).some((slotsOfLoc) =>
    slotsOfLoc.some(
      (t) =>
        t &&
        t.player === seat &&
        !t.flipped &&
        (t.tile.industry === 'cotton' || t.tile.industry === 'manufacturer' || t.tile.industry === 'pottery'),
    ),
  );
  const hints: string[] = [];
  if (selectedCard !== null) {
    if (builds.length === 0 && networks.length === 0 && sells.length === 0) {
      hints.push('该牌当前没有可执行的建造/连接目标（可能：运河时代每城限 1 块、无匹配空槽、不在你的网络内）。');
    }
    if (sells.length === 0 && hasSellableOnBoard) {
      hints.push('有可卖板块但暂不可售：板块需连通到收该货图标的商人（自己的酒不需连通）。');
    }
  }

  const preview = draft.resolved !== null ? previewOf(draft.resolved, state, seat) : null;

  return (
    <section className="action-bar" data-testid="action-bar">
      <div className="action-bar-head">
        <h3>行动</h3>
        {moneyChip(true)}
      </div>
      {/* 啤酒实况常驻显示(项 5) */}
      <p className="beer-status" data-testid="beer-status">
        啤酒：{ownBreweries.length > 0 ? `酒厂 ${ownBreweries.join('、')}` : '无酒厂余量'}
        {merchantBeers.length > 0 ? `｜商人 ${merchantBeers.join('、')}` : ''}
      </p>
      {selectedCard === null ? (
        <p data-testid="select-card-hint">从手牌中选一张牌，棋盘将高亮可执行的目标。</p>
      ) : null}
      <div className="action-sections">
        {/* 建造行:常驻;产业按钮带 等级+花费,点选后棋盘高亮只留该产业槽位 */}
        <div className={`action-choices${builds.length === 0 ? ' row-disabled' : ''}`} data-testid="build-options">
          <span>建造：</span>
          {buildIndustries.length === 0 ? (
            <span className="action-row-none">选牌后在此选产业</span>
          ) : (
            buildIndustries.map((ind) => {
              const tile = state.players[seat]?.tiles.find((t) => t.industry === ind);
              return (
                <button
                  key={ind}
                  type="button"
                  data-testid={`build-ind-${ind}`}
                  className={draft.buildIndustry === ind ? 'selected' : undefined}
                  onClick={() => draft.pickIndustry(ind)}
                >
                  {industryName(ind)}
                  {tile !== undefined
                    ? ` L${tile.level} £${tile.costMoney}${tile.costCoal > 0 ? `·煤${tile.costCoal}` : ''}${tile.costIron > 0 ? `·铁${tile.costIron}` : ''}`
                    : ''}
                </button>
              );
            })
          )}
          {builds.length > 0 ? <span className="action-row-hint">再点棋盘高亮槽位</span> : null}
        </div>
        {draft.buildChoices.length > 0 ? (
          <div className="action-choices" data-testid="build-choices">
            <span>该槽位可建：</span>
            {draft.buildChoices.map((a) => (
              <button
                key={a.industry}
                type="button"
                onClick={() => draft.choose(a)}
              >
                {describeAction(a)}
              </button>
            ))}
          </div>
        ) : null}

        <div className={`action-choices${networks.length === 0 ? ' row-disabled' : ''}`} data-testid="network-row">
          <span>连接：</span>
          {networks.length === 0 ? (
            <span className="action-row-none">—</span>
          ) : (
            <span className="action-row-hint" data-testid="network-progress">
              已选 {draft.pickedLinks.length} 条
              {draft.networkCanExtend ? '（可继续点第二条）' : ''}
              ；点高亮边，点末条撤销。
            </span>
          )}
        </div>

        <div className={`action-choices${draft.developChoices.length === 0 ? ' row-disabled' : ''}`} data-testid="develop-options">
          <span>研发{draft.developChoices.length > 0 ? '（1-2 块；同产业再点一次 = 研发两块）' : ''}：</span>
          {draft.developChoices.length === 0 ? (
            <span className="action-row-none">—</span>
          ) : (
            draft.developChoices.map((ind) => {
              const count = draft.developPicks.filter((x) => x === ind).length;
              return (
                <button
                  key={ind}
                  type="button"
                  data-testid={`develop-opt-${ind}`}
                  className={count > 0 ? 'selected' : undefined}
                  onClick={() => draft.toggleDevelop(ind)}
                >
                  {industryName(ind)}
                  {count > 0 ? ` ×${count}` : ''}
                </button>
              );
            })
          )}
        </div>

        {(() => {
          const sellRowDisabled = draft.sellSingles.length === 0 && draft.sellFullSet === null && draft.sellGroups.length === 0;
          // 该板块当前真能卖向的商人(可达+收货+啤酒总量够),建筑行只列非空的
          const feasibleMerchants = (t: SlotRef, beerToFlip: number): MerchantId[] =>
            merchantsForTile(state, t).filter((id) => {
              const src = beerSourcesFor(state, seat, id);
              const total =
                (src.merchantBarrel ? 1 : 0) +
                src.own.reduce((s, b) => s + b.barrels, 0) +
                src.opponent.reduce((s, b) => s + b.barrels, 0);
              return total >= beerToFlip;
            });
          const sellableNow = sellableTilesFor(state, seat).filter(
            (t) =>
              !draft.sellGroups.some((g) => g.tile.location === t.location && g.tile.slotIndex === t.slotIndex) &&
              feasibleMerchants(t, t.beerToFlip).length > 0,
          );
          const curPlaced = draft.sellTile !== null ? state.board.slots[draft.sellTile.location]?.[draft.sellTile.slotIndex] : null;
          const curNeed = curPlaced?.tile.beerToFlip ?? 0;
          const curMerchants = draft.sellTile !== null ? feasibleMerchants(draft.sellTile, curNeed) : [];
          const curBeerSources = draft.sellMerchant !== null ? beerSourcesFor(state, seat, draft.sellMerchant) : null;
          const breweryUsed = new Map<string, number>();
          for (const b of draft.sellBeer) {
            if (b.kind !== 'brewery') continue;
            const k = `${b.location}:${b.slotIndex}`;
            breweryUsed.set(k, (breweryUsed.get(k) ?? 0) + 1);
          }
          const BARREL_NUM = ['①', '②', '③', '④', '⑤'];
          return (
            <>
              <div className={`action-choices${sellRowDisabled ? ' row-disabled' : ''}`} data-testid="sell-options">
                <span>出售：</span>
                {sellRowDisabled ? (
                  <span className="action-row-none">—</span>
                ) : (
                  <>
                    {draft.sellGroups.map((g, i) => {
                      const placed = state.board.slots[g.tile.location]?.[g.tile.slotIndex];
                      return (
                        <button
                          key={i}
                          type="button"
                          data-testid={`sell-group-${i}`}
                          title="点击移除本组"
                          onClick={() => draft.removeSellGroup(i)}
                        >
                          {locationName(g.tile.location)}
                          {placed !== null && placed !== undefined ? industryName(placed.tile.industry) : ''}→{merchantName(g.merchant)}（酒×{g.beer.length}）✕
                        </button>
                      );
                    })}
                    {draft.sellFullSet !== null && draft.sellGroups.length === 0 ? (
                      <button
                        type="button"
                        data-testid="sell-full-set"
                        onClick={() => draft.choose(draft.sellFullSet!)}
                      >
                        一键：{describeAction(draft.sellFullSet)}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
              {!sellRowDisabled ? (
                <div className="sell-builder" data-testid="sell-builder">
                  <div className="action-choices">
                    <span>板块：</span>
                    {sellableNow.map((t) => (
                      <button
                        key={`${t.location}:${t.slotIndex}`}
                        type="button"
                        data-testid={`sell-tile-${t.location}-${t.slotIndex}`}
                        className={
                          draft.sellTile?.location === t.location && draft.sellTile.slotIndex === t.slotIndex
                            ? 'selected'
                            : undefined
                        }
                        onClick={() => draft.pickSellTile(t)}
                      >
                        {locationName(t.location)}{industryName(t.industry)} L{t.level}
                        {t.beerToFlip > 0 ? `（酒×${t.beerToFlip}）` : ''}
                      </button>
                    ))}
                  </div>
                  {draft.sellTile !== null ? (
                    <div className="action-choices">
                      <span>贸易商：</span>
                      {curMerchants.length === 0 ? (
                        <span className="action-row-none">无可达且收货的商人（或啤酒不足）</span>
                      ) : (
                        curMerchants.map((id) => (
                          <button
                            key={id}
                            type="button"
                            data-testid={`sell-merchant-${id}`}
                            className={draft.sellMerchant === id ? 'selected' : undefined}
                            onClick={() => draft.pickSellMerchant(id)}
                          >
                            {merchantName(id)}
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}
                  {draft.sellTile !== null && draft.sellMerchant !== null && curBeerSources !== null && curNeed > 0 ? (
                    <div className="action-choices">
                      <span>酒（还需 {curNeed - draft.sellBeer.length}）：</span>
                      {curBeerSources.merchantBarrel ? (
                        <button
                          type="button"
                          data-testid="sell-beer-merchant"
                          className={draft.sellBeer.some((b) => b.kind === 'merchant') ? 'selected' : undefined}
                          disabled={!draft.sellBeer.some((b) => b.kind === 'merchant') && draft.sellBeer.length >= curNeed}
                          onClick={() => draft.toggleSellMerchantBarrel()}
                        >
                          {merchantName(draft.sellMerchant)}桶
                        </button>
                      ) : null}
                      {[
                        ...curBeerSources.own.map((b) => ({ ...b, own: true })),
                        ...curBeerSources.opponent.map((b) => ({ ...b, own: false })),
                      ].map((b) => {
                        const k = `${b.location}:${b.slotIndex}`;
                        const used = breweryUsed.get(k) ?? 0;
                        return Array.from({ length: b.barrels }, (_, i) => {
                          const selected = used > i;
                          return (
                            <button
                              key={`${k}-${i}`}
                              type="button"
                              data-testid={`sell-beer-${b.location}-${b.slotIndex}-${i}`}
                              className={selected ? 'selected' : undefined}
                              disabled={!selected && draft.sellBeer.length >= curNeed}
                              onClick={() => draft.setSellBreweryCount(b, selected ? i : i + 1)}
                            >
                              {b.own ? '自家' : '对手'}·{locationName(b.location)}{BARREL_NUM[i] ?? `${i + 1}`}
                            </button>
                          );
                        });
                      })}
                    </div>
                  ) : null}
                  {draft.sellTile !== null && draft.sellMerchant !== null && draft.sellBeer.length === curNeed && sellableNow.length > 1 ? (
                    <div className="action-choices">
                      <button type="button" data-testid="sell-commit-group" onClick={() => draft.commitSellGroup()}>
                        收下本组，选下一组
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          );
        })()}

        <div className={`action-choices${draft.scoutAvailable ? '' : ' row-disabled'}`} data-testid="scout-options">
          <span>侦察{draft.scoutAvailable ? `：选 3 张弃牌（已选 ${draft.scoutPicks.length}/3）` : '：'}</span>
          {!draft.scoutAvailable ? (
            <span className="action-row-none">—</span>
          ) : (
            hand.map((c) => (
              <button
                key={c.id}
                type="button"
                data-testid={`scout-card-${c.id}`}
                className={draft.scoutPicks.includes(c.id) ? 'selected' : undefined}
                disabled={draft.scoutPicks.length >= 3 && !draft.scoutPicks.includes(c.id)}
                onClick={() => draft.toggleScoutCard(c.id)}
              >
                {cardName(c)}
              </button>
            ))
          )}
        </div>

        <div className={`action-choices${loan === undefined && !onlyPass ? ' row-disabled' : ''}`} data-testid="loan-row">
          <span>贷款：</span>
          {loan === undefined && !onlyPass ? (
            <span className="action-row-none">—</span>
          ) : (
            <>
              {loan !== undefined ? (
                <button type="button" data-testid="quick-loan" onClick={() => draft.choose(loan)}>
                  £30（收入 −3 级）
                </button>
              ) : null}
              {/* 过:仅当该牌没有任何其他可执行行动时兜底出现,防死锁 */}
              {onlyPass && pass !== undefined ? (
                <button type="button" data-testid="quick-pass" onClick={() => draft.choose(pass)}>
                  {describeAction(pass)}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="action-confirm">
        {hints.map((h) => (
          <p className="action-blocked-hint" data-testid="blocked-hint" key={h}>
            {h}
          </p>
        ))}
        {preview !== null && (preview.gains.length > 0 || preview.costs.length > 0) ? (
          <p className="action-preview" data-testid="action-preview">
            {preview.gains.length > 0 ? `收益：${preview.gains.join('、')}` : ''}
            {preview.gains.length > 0 && preview.costs.length > 0 ? '｜' : ''}
            {preview.costs.length > 0 ? `花费：${preview.costs.join('、')}` : ''}
          </p>
        ) : null}
        <button
          type="button"
          data-testid="confirm-action"
          disabled={draft.resolved === null}
          onClick={onConfirm}
        >
          {draft.resolved === null ? '确认（先完成选择）' : `确认：${describeAction(draft.resolved)}`}
        </button>
        <button
          type="button"
          data-testid="cancel-draft"
          title="清空当前未确认的选择（不影响已提交的行动）"
          onClick={onCancel}
        >
          取消选择
        </button>
        <button
          type="button"
          data-testid="reset-turn"
          className="btn-ghost"
          disabled={!canResetTurn}
          title={canResetTurn ? '撤销本回合已提交的全部行动,回到回合初' : '本回合还没有可撤回的行动'}
          onClick={onResetTurn}
        >
          重置本回合
        </button>
      </div>
    </section>
  );
}
