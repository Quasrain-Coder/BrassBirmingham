/**
 * 宽屏顶部行动栏（"固定屏幕不滚动"重构）：地图上方一行——行动类型按钮
 * （建造/研发/出售/搜寻/贷款,网络纯地图点选）+ 确认/取消/重置 + 现金标记;
 * 选中卡牌并按下某类型后,下一行展开该类型的细节(建造产业按钮/研发按钮/
 * 卖出分组选择器/搜寻卡牌按钮,搜寻同时与下方手牌点选绑定)。
 * 经典布局仍用底部 ActionBar;本组件与 ActionBar 共用 useActionDraft 与 SellDetails。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { Action, Card, PlayerIndex } from '@brass/engine';
import type { FilteredState } from '@brass/protocol';
import type { ActionDraft } from './ActionBar';
import { SellDetails } from './ActionBar';
import { buildActionLabel } from './interactions';
import { cardName, describeAction, industryName, locationName } from './display';
import { moneyDelta, previewOf } from './preview';

export type TopActionKind = 'build' | 'develop' | 'sell' | 'scout' | 'loan' | null;

export interface TopActionBarProps {
  myTurn: boolean;
  waitingFor: string;
  selectedCard: string | null;
  hand: Card[];
  draft: ActionDraft;
  state: FilteredState;
  turnHold: PlayerIndex | null;
  seat: PlayerIndex;
  canResetTurn: boolean;
  active: TopActionKind;
  onActiveChange: (k: TopActionKind) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onEndTurn: () => void;
  onResetTurn: () => void;
}

export function TopActionBar({
  myTurn,
  waitingFor,
  selectedCard,
  hand,
  draft,
  state,
  turnHold,
  seat,
  canResetTurn,
  active,
  onActiveChange,
  onConfirm,
  onCancel,
  onEndTurn,
  onResetTurn,
}: TopActionBarProps): ReactElement {
  // 现金实时标记:显眼处常驻;暂存行动时预览结算后的现金(取消/重置即恢复)
  const money = state.players[seat]?.money ?? 0;
  const projected =
    draft.resolved !== null ? money + moneyDelta(draft.resolved, state, seat) : null;
  const moneyChip = (
    <span className="action-money" data-testid="action-money">
      £{money}
      {myTurn && projected !== null && projected !== money ? (
        <span className={`action-money-delta ${projected > money ? 'pos' : 'neg'}`}>
          → £{projected}
        </span>
      ) : null}
    </span>
  );

  // 回合打满待确认:显式"结束回合"放行;"重置本回合"撤销重来(红色提醒)
  if (turnHold === seat) {
    return (
      <section className="action-bar top-action-bar turn-hold" data-testid="action-bar">
        <div className="top-action-row">
          <span className="top-action-hint" data-testid="turn-hold-hint">
            本回合行动已完成,确认后进入下一位玩家;也可以重置本回合重新行动。
          </span>
          <button type="button" data-testid="end-turn" onClick={onEndTurn}>
            结束回合
          </button>
          <button type="button" data-testid="reset-turn" className="btn-ghost" onClick={onResetTurn}>
            重置本回合
          </button>
          <span className="top-action-money">{moneyChip}</span>
        </div>
      </section>
    );
  }
  if (!myTurn) {
    return (
      <section className="action-bar top-action-bar" data-testid="action-bar">
        <div className="top-action-row">
          <span className="top-action-hint" data-testid="waiting">
            {state.phase === 'game-over'
              ? '对局已结束,可自由查看版图与记录'
              : turnHold !== null
                ? `等待 ${waitingFor} 确认回合…`
                : `等待 ${waitingFor} 行动…`}
          </span>
          <span className="top-action-money">{moneyChip}</span>
        </div>
      </section>
    );
  }

  const builds = draft.candidates.filter((a) => a.type === 'build');
  const sells = draft.candidates.filter((a) => a.type === 'sell');
  const loan = draft.candidates.find((a) => a.type === 'loan');
  const pass = draft.candidates.find((a) => a.type === 'pass');
  const onlyPass =
    draft.candidates.length > 0 && draft.candidates.every((a) => a.type === 'pass');
  const buildIndustries = [...new Set(builds.map((a) => a.industry))];
  const sellAvailable = sells.length > 0 || draft.sellFullSet !== null;

  // 建造行全局显隐(与经典布局同一 localStorage 键)
  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  const [buildHidden, setBuildHidden] = useState<boolean>(
    () => storage?.getItem('brass-build-row') === 'hidden',
  );
  const toggleBuildHidden = (): void => {
    const v = !buildHidden;
    setBuildHidden(v);
    storage?.setItem('brass-build-row', v ? 'hidden' : 'visible');
  };

  const toggle = (k: NonNullable<TopActionKind>): void => {
    onActiveChange(active === k ? null : k);
  };
  const preview = draft.resolved !== null ? previewOf(draft.resolved, state, seat) : null;

  return (
    <section className="action-bar top-action-bar" data-testid="action-bar">
      <div className="top-action-row">
        <button
          type="button"
          data-testid="top-act-build"
          className={active === 'build' ? 'selected' : undefined}
          disabled={builds.length === 0}
          title={buildHidden ? '建造行已被你隐藏(再点展开)' : undefined}
          onClick={() => toggle('build')}
        >
          建造
        </button>
        <button
          type="button"
          data-testid="top-act-develop"
          className={active === 'develop' ? 'selected' : undefined}
          disabled={draft.developChoices.length === 0}
          onClick={() => toggle('develop')}
        >
          研发
        </button>
        <button
          type="button"
          data-testid="top-act-sell"
          className={active === 'sell' ? 'selected' : undefined}
          disabled={!sellAvailable}
          onClick={() => toggle('sell')}
        >
          出售
        </button>
        <button
          type="button"
          data-testid="top-act-scout"
          className={active === 'scout' ? 'selected' : undefined}
          disabled={!draft.scoutAvailable}
          onClick={() => toggle('scout')}
        >
          搜寻
        </button>
        <button
          type="button"
          data-testid="quick-loan"
          className={draft.resolved?.type === 'loan' ? 'selected' : undefined}
          disabled={loan === undefined}
          onClick={loan !== undefined ? () => draft.choose(loan) : undefined}
        >
          贷款
        </button>
        {onlyPass && pass !== undefined ? (
          <button type="button" data-testid="quick-pass" onClick={() => draft.choose(pass)}>
            过
          </button>
        ) : null}
        <span className="top-action-spacer" />
        <button
          type="button"
          data-testid="confirm-action"
          className="top-confirm"
          disabled={draft.resolved === null}
          onClick={onConfirm}
        >
          {draft.resolved === null ? '确认' : `确认：${describeShort(draft.resolved, state, seat)}`}
        </button>
        <button type="button" data-testid="cancel-draft" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          data-testid="reset-turn"
          className="btn-ghost"
          disabled={!canResetTurn}
          onClick={onResetTurn}
        >
          重置
        </button>
        <span className="top-action-money">{moneyChip}</span>
      </div>

      {/* 双轨选酒行:与底部 ActionBar 同款(选完两条路后出现;不可用商人桶) */}
      {draft.networkBeerOptions.length > 0 ? (
        <div className="action-choices top-detail-row" data-testid="network-beer-options">
          <span>双轨酒（选 1 桶）：</span>
          {draft.networkBeerOptions.map((o) => (
            <button
              key={`${o.location}:${o.slotIndex}`}
              type="button"
              data-testid={`network-beer-${o.location}-${o.slotIndex}`}
              className={
                draft.networkBeer?.location === o.location && draft.networkBeer.slotIndex === o.slotIndex
                  ? 'selected'
                  : undefined
              }
              onClick={() => draft.pickNetworkBeer(o)}
            >
              {o.own ? '自家' : '对手'}·{locationName(o.location)}（{o.barrels} 桶）
            </button>
          ))}
          {draft.networkBeer === null ? (
            <span className="action-row-none">不选则按序自动消耗</span>
          ) : null}
        </div>
      ) : null}

      {active === 'build' ? (
        <div className="action-choices top-detail-row" data-testid="build-options">
          <span>建造：</span>
          {buildIndustries.length === 0 ? (
            <span className="action-row-none">该牌没有可建产业</span>
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
          <button type="button" className="row-toggle" title="隐藏建造按钮(全局记住)" onClick={toggleBuildHidden}>
            −
          </button>
        </div>
      ) : null}
      {active === 'build' && draft.buildChoices.length > 0 ? (
        <div className="action-choices" data-testid="build-choices">
          <span>该槽位可建：</span>
          {draft.buildChoices.map((a) => (
            <button key={a.industry} type="button" onClick={() => draft.choose(a)}>
              {industryName(a.industry)}
            </button>
          ))}
        </div>
      ) : null}

      {active === 'develop' ? (
        <div className="action-choices top-detail-row" data-testid="develop-options">
          <span>研发（同产业再点一次 = 研发两块）：</span>
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

      {active === 'sell' ? <SellDetails draft={draft} state={state} seat={seat} /> : null}

      {active === 'scout' ? (
        <div className="action-choices top-detail-row" data-testid="scout-options">
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

      {preview !== null && (preview.gains.length > 0 || preview.costs.length > 0) ? (
        <p className="action-preview" data-testid="action-preview">
          {preview.gains.length > 0 ? `收益：${preview.gains.join('、')}` : ''}
          {preview.gains.length > 0 && preview.costs.length > 0 ? '｜' : ''}
          {preview.costs.length > 0 ? `花费：${preview.costs.join('、')}` : ''}
        </p>
      ) : null}
    </section>
  );
}

/** 确认钮短文案:过长时截断。 */
function describeShort(action: Action, state?: FilteredState, seat?: PlayerIndex): string {
  const text: string =
    state !== undefined && seat !== undefined ? buildActionLabel(state, seat, action) : describeAction(action);
  return text.length > 18 ? `${text.slice(0, 18)}…` : text;
}
