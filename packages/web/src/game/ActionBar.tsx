/**
 * 行动交互层（M2 Task 11）：useActionDraft 参数收集状态机 + ActionBar 展示组件。
 *
 * 核心规则：**提交的行动必须是 legalActions 中匹配到的条目本身**（draft.resolved 恒为
 * 入参数组原对象，由测试断言 toContain），绝不新构造 Action——engine 对 scout cardIds
 * 有序逐元素比较、sell 只枚举单块/全集。参数收集 = 逐步缩小 legalActions 子集：
 * - build：点棋盘槽位 → buildCandidatesAt（多产业槽歧义时列出待选）
 * - network：按放置顺序点边（双轨有序对），matchNetwork 前缀收窄；点末条撤销
 * - develop：点 1-2 个产业按钮，normalizeRemovals 后精确匹配
 * - sell：单卖按钮逐个列出（点板块槽位可过滤）+ "可卖全集"一键
 * - scout：从手牌选 3 张，matchScout 按手牌序排序匹配 i<j<k 枚举项
 * - loan/pass：无参数，点按钮即暂存待确认
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { Action, Card, IndustryType, LocationId, MerchantId, PlayerIndex } from '@brass/engine';
import type { FilteredState } from '@brass/protocol';
import type { BoardHighlights, SlotRef } from '../board/BoardSvg';
import {
  actionsForCard,
  buildCandidatesAt,
  buildSlotTargets,
  describeAction,
  developDoubles,
  developOptions,
  extendableLinks,
  matchDevelop,
  matchNetwork,
  matchScout,
  resolveBuildSlot,
  sellCandidatesAt,
  sellOptions,
  sellSlotTargets,
  targetsFor,
} from './interactions';
import type { BuildAction, SellAction } from './interactions';
import { cardName, industryName, locationName, merchantName } from './display';
import { previewOf } from './preview';

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
  /** 槽位歧义（一槽多产业）时的待选 build。 */
  buildChoices: BuildAction[];
  /** 建造预览（非贴合的预览 token 盖在目标槽位，切换城市即跟随）。 */
  buildPreview: { location: LocationId; slotIndex: number; industry: IndustryType } | null;
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
  const [buildChoices, setBuildChoices] = useState<BuildAction[]>([]);
  const [chosen, setChosen] = useState<Action | null>(null);

  const reset = (): void => {
    setPickedLinks([]);
    setDevelopPicks([]);
    setScoutPicks([]);
    setSellTile(null);
    setBuildChoices([]);
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
    const targets = targetsFor(selectedCard, legalActions);
    const buildSlots = buildSlotTargets(targets, state.board.slots);
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
  }, [selectedCard, legalActions, candidates, state.board.slots, state.merchants, seat, pickedLinks]);

  const networkMatch = matchNetwork(candidates, pickedLinks);
  const sell = sellOptions(candidates);
  const visibleSellSingles =
    sellTile === null
      ? sell.singles
      : sellCandidatesAt(candidates, sellTile.location, sellTile.slotIndex);

  // resolved 优先级：显式选定 > 槽位歧义待选（阻断）> network 序列 > develop > scout。
  // 多类型同时收集了参数时按此序取其一，确认钮文案可见所提交内容。
  const resolved: Action | null =
    chosen ??
    (buildChoices.length > 0
      ? null
      : (pickedLinks.length > 0 ? networkMatch.exact : null) ??
        matchDevelop(candidates, developPicks) ??
        matchScout(legalActions, hand, scoutPicks));

  const clickSlot = (location: LocationId, slotIndex: number): void => {
    const builds = buildCandidatesAt(candidates, location, slotIndex);
    if (builds.length === 1) {
      setChosen(builds[0]!);
      setBuildChoices([]);
      return;
    }
    if (builds.length > 1) {
      setBuildChoices(builds);
      setChosen(null);
      return;
    }
    const sells = sellCandidatesAt(candidates, location, slotIndex);
    if (sells.length > 0) {
      setSellTile({ location, slotIndex });
    }
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
    setChosen(action);
    setBuildChoices([]);
  };

  /** 建造预览:落槽按引擎规范化(单图标槽优先等,resolveBuildSlot)——与实际结算一致。 */
  const buildPreview = useMemo(() => {
    if (chosen?.type !== 'build') return null;
    const def = state.players[seat]?.tiles.find((t) => t.industry === chosen.industry);
    if (def === undefined) return null;
    const target = resolveBuildSlot(state, seat, chosen.location, chosen.industry, def.level);
    if (target === null) return null;
    return { location: target.location, slotIndex: target.slotIndex, industry: chosen.industry };
  }, [chosen, state, seat]);

  /** 啤酒匹配线:resolved 为卖货时,每笔销售的啤酒来源 → 卖货地点(match 效果)。 */
  const beerMatches = useMemo(() => {
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
  }, [resolved, state.board.slots, seat]);

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
    buildChoices,
    buildPreview,
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
  // 回合打满待确认:显式"结束回合"放行;"重置本回合"撤销重来
  if (turnHold === seat) {
    return (
      <section className="action-bar turn-hold" data-testid="action-bar">
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
        <p data-testid="waiting">
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
      <h3>行动</h3>
      {/* 啤酒实况常驻显示(项 5) */}
      <p className="beer-status" data-testid="beer-status">
        啤酒：{ownBreweries.length > 0 ? `酒厂 ${ownBreweries.join('、')}` : '无酒厂余量'}
        {merchantBeers.length > 0 ? `｜商人 ${merchantBeers.join('、')}` : ''}
      </p>
      {selectedCard === null ? (
        <p data-testid="select-card-hint">从手牌中选一张牌，棋盘将高亮可执行的目标。</p>
      ) : (
        <div className="action-sections">
          {builds.length > 0 ? (
            <p className="action-hint">建造：点击棋盘高亮槽位。</p>
          ) : null}
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

          {networks.length > 0 ? (
            <p className="action-hint" data-testid="network-progress">
              连接：已选 {draft.pickedLinks.length} 条
              {draft.networkCanExtend ? '（可继续点第二条）' : ''}
              ；点高亮边，点末条撤销。
            </p>
          ) : null}

          {draft.developChoices.length > 0 ? (
            <div className="action-choices" data-testid="develop-options">
              <span>研发（1-2 块；同产业再点一次 = 研发两块）：</span>
              {draft.developChoices.map((ind) => {
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
              })}
            </div>
          ) : null}

          {draft.sellSingles.length > 0 || draft.sellFullSet !== null ? (
            <div className="action-choices" data-testid="sell-options">
              <span>出售：</span>
              {draft.sellSingles.map((a, i) => (
                <button
                  key={describeAction(a)}
                  type="button"
                  data-testid={`sell-single-${i}`}
                  onClick={() => draft.choose(a)}
                >
                  {describeAction(a)}
                </button>
              ))}
              {draft.sellFullSet !== null ? (
                <button
                  type="button"
                  data-testid="sell-full-set"
                  onClick={() => draft.choose(draft.sellFullSet!)}
                >
                  {describeAction(draft.sellFullSet)}
                </button>
              ) : null}
            </div>
          ) : null}

          {draft.scoutAvailable ? (
            <div className="action-choices" data-testid="scout-options">
              <span>侦察：选 3 张弃牌（已选 {draft.scoutPicks.length}/3）</span>
              {hand.map((c) => (
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
              ))}
            </div>
          ) : null}

          {loan !== undefined || onlyPass ? (
            <div className="action-choices">
              {loan !== undefined ? (
                <>
                  <span>贷款：</span>
                  <button type="button" data-testid="quick-loan" onClick={() => draft.choose(loan)}>
                    £30（收入 −3 级）
                  </button>
                </>
              ) : null}
              {onlyPass && pass !== undefined ? (
                <>
                  <span>其他：</span>
                  <button type="button" data-testid="quick-pass" onClick={() => draft.choose(pass)}>
                    {describeAction(pass)}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

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
