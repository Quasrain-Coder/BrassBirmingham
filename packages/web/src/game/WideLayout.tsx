/**
 * 宽屏布局(27 寸显示器全屏):地图居中,左/右两列各放玩家面板(全部铺开,
 * 面板图/明细双模式与经典布局一致),每个面板下方一行本回合关键信息
 * (顺位、回合前金钱-开销-回合后金钱、本回合两动)。地图底下是我方手牌与行动。
 */
import type { ReactElement } from 'react';
import type { PlayerIndex } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { PLAYER_COLORS } from '../board/BoardSvg';
import { describeAction } from './display';
import { playerName } from './Panels';
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
  const before = p.money + p.spentThisRound;
  return (
    <div className="round-info" data-testid={`round-info-${seat}`}>
      <span className="round-info-rank" style={{ borderColor: PLAYER_COLORS[seat] }}>
        {rank === -1 ? '—' : `#${rank}`}
      </span>
      <span className="round-info-money">
        前 £{before} · 开销 £{p.spentThisRound} · 后 £{p.money}
      </span>
      <span className="round-info-acts">
        {acts.length > 0 ? acts.map((a) => describeAction(a.action)).join('；') : '本回合未行动'}
      </span>
      <span className="round-info-name">{playerName(room ?? undefined, seat)}</span>
    </div>
  );
}
