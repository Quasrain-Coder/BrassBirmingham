/**
 * 宽屏布局(27 寸显示器全屏):地图居中,左/右两列各放玩家面板(全部铺开,
 * 面板图/明细双模式与经典布局一致),每个面板下方一行本回合关键信息
 * (顺位、回合前金钱-开销-回合后金钱、本回合两动)。地图底下是我方手牌与行动。
 */
import type { ReactElement, CSSProperties } from 'react';
import { useState } from 'react';
import type { Action, PlayerIndex } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { PLAYER_COLORS } from '../board/BoardSvg';
import { describeAction } from './display';
import type { LogEntry } from './store';

/** 本轮每玩家行动数(运河首轮 1,其余 2)。 */
function actionsPerRound(state: FilteredState): number {
  return state.era === 'canal' && state.round === 1 ? 1 : 2;
}

/** 本回合开始 seq(当前快照 seq 回推本回合已行动数)。 */
export function roundStartSeq(state: FilteredState, seq: number): number {
  const played = state.currentPlayerIdx * actionsPerRound(state) + state.actionsThisTurn;
  return Math.max(0, seq - played);
}

/** 面板下方的本回合信息行:顺位、回合前金钱-本回合开销-回合后金钱、本回合行动(日志级简洁)。 */
export function RoundInfo({
  state,
  seat,
  seq,
  log,
  room,
}: {
  state: FilteredState;
  seat: PlayerIndex;
  seq: number;
  log: LogEntry[];
  room: RoomState | null;
}): ReactElement {
  const p = state.players[seat]!;
  const rank = state.turnOrder.indexOf(seat) + 1;
  const start = roundStartSeq(state, seq);
  const acts = log.filter((e) => e.seq >= start && e.player === seat);
  const active = state.turnOrder[state.currentPlayerIdx] === seat;
  return (
    <div
      className={`round-info${active ? ' active' : ''}`}
      data-testid={`round-info-${seat}`}
      style={active ? ({ '--pulse-color': PLAYER_COLORS[seat] } as CSSProperties) : undefined}
    >
      <span className="round-info-rank" style={{ borderColor: PLAYER_COLORS[seat] }}>
        {rank === -1 ? '—' : `#${rank}`}
      </span>
      <span className="round-info-spent">开销 £{p.spentThisRound}</span>
      <span
        className="round-info-acts"
        title={acts.length > 0 ? acts.map((a) => describeAction(a.action)).join('；') : '本回合未行动'}
      >
        {acts.length > 0 ? acts.map((a) => describeAction(a.action)).join('；') : '本回合未行动'}
      </span>
    </div>
  );
}

/**
 * 面板下方的"本时代行动"折叠记录:展开后按顺序列出该玩家本时代全部行动
 * (与日志同级简洁度;数据来自快照 eraActions,resume/重放后仍完整)。
 */
export function EraActions({
  seat,
  actions,
}: {
  seat: PlayerIndex;
  actions: Action[];
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="era-actions" data-testid={`era-actions-${seat}`}>
      <button
        type="button"
        className="era-actions-toggle"
        data-testid={`era-actions-toggle-${seat}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        本时代 {actions.length} 动<span className="board-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        actions.length === 0 ? (
          <p className="era-actions-empty">本时代尚未行动</p>
        ) : (
          <ol className="era-actions-list">
            {actions.map((a, i) => (
              <li key={i}>{describeAction(a)}</li>
            ))}
          </ol>
        )
      ) : null}
    </div>
  );
}
