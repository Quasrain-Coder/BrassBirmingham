import { actionsPerRound } from '@brass/engine';
import type { GameState } from '@brass/engine';

/** 行动位置：首轮每人 1 动，其余轮每人 2 动；round 跨时代连续编号。 */
export function decisionTurn(state: GameState): number {
  const previousTurns = state.round === 1
    ? 0
    : state.playerCount + (state.round - 2) * state.playerCount * 2;
  return previousTurns + state.currentPlayerIdx * actionsPerRound(state) + state.actionsThisTurn;
}
