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
import type { Action, Card, IndustryType, LocationId, PlayerIndex } from '@brass/engine';
import type { FilteredState } from '@brass/protocol';
import type { BoardHighlights, SlotRef } from '../board/BoardSvg';
import {
  actionsForCard,
  buildCandidatesAt,
  buildSlotTargets,
  describeAction,
  developOptions,
  extendableLinks,
  matchDevelop,
  matchNetwork,
  matchScout,
  sellCandidatesAt,
  sellOptions,
  sellSlotTargets,
  targetsFor,
} from './interactions';
import type { BuildAction, SellAction } from './interactions';
import { cardLabel } from './Panels';

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
    const slots = [
      ...buildSlotTargets(targets, state.board.slots),
      ...sellSlotTargets(candidates),
    ];
    return { slots, links: [...extendableLinks(candidates, pickedLinks)] };
  }, [selectedCard, legalActions, candidates, state.board.slots, pickedLinks]);

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

  const toggleDevelop = (ind: IndustryType): void => {
    setDevelopPicks((prev) => {
      const i = prev.indexOf(ind);
      if (i >= 0) return [...prev.slice(0, i), ...prev.slice(i + 1)];
      if (prev.length >= 2) return prev; // develop 至多 2 块
      return [...prev, ind];
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
  onConfirm: () => void;
  onCancel: () => void;
}

export function ActionBar({
  myTurn,
  waitingFor,
  selectedCard,
  hand,
  draft,
  onConfirm,
  onCancel,
}: ActionBarProps): ReactElement {
  if (!myTurn) {
    return (
      <section className="action-bar" data-testid="action-bar">
        <p data-testid="waiting">等待 {waitingFor} 行动…</p>
      </section>
    );
  }

  const builds = draft.candidates.filter((a) => a.type === 'build');
  const networks = draft.candidates.filter((a) => a.type === 'network');
  const loan = draft.candidates.find((a) => a.type === 'loan');
  const pass = draft.candidates.find((a) => a.type === 'pass');

  return (
    <section className="action-bar" data-testid="action-bar">
      <h3>行动</h3>
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
              <span>研发（1-2 块）：</span>
              {draft.developChoices.map((ind) => (
                <button
                  key={ind}
                  type="button"
                  data-testid={`develop-opt-${ind}`}
                  className={draft.developPicks.includes(ind) ? 'selected' : undefined}
                  onClick={() => draft.toggleDevelop(ind)}
                >
                  {ind}
                </button>
              ))}
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
                  {cardLabel(c)}
                </button>
              ))}
            </div>
          ) : null}

          <div className="action-choices">
            {loan !== undefined ? (
              <button type="button" data-testid="quick-loan" onClick={() => draft.choose(loan)}>
                {describeAction(loan)}
              </button>
            ) : null}
            {pass !== undefined ? (
              <button type="button" data-testid="quick-pass" onClick={() => draft.choose(pass)}>
                {describeAction(pass)}
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="action-confirm">
        <button
          type="button"
          data-testid="confirm-action"
          disabled={draft.resolved === null}
          onClick={onConfirm}
        >
          {draft.resolved === null ? '确认（先完成选择）' : `确认：${describeAction(draft.resolved)}`}
        </button>
        <button type="button" data-testid="cancel-draft" onClick={onCancel}>
          重选
        </button>
      </div>
    </section>
  );
}
