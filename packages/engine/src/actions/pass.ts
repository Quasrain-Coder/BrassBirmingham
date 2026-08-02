/**
 * Pass 行动：执行（rules-reference §6.8）。
 *
 * Pass 本身不产生任何状态变更（lastEvents 清空，与其他 applyX 一致）；仍须弃 1 张卡——
 * 弃牌结算在 Task 11 applyAction 统一处理，此模块只校验 cardId 在手中。无枚举函数（applyAction 按手牌逐张构造）。
 *
 * 纯函数：不改入参。
 */
import { IllegalActionError } from '../errors.js';
import type { GameState } from '../state.js';
import type { Action, PlayerIndex } from '../types.js';

/** 执行 Pass：校验 cardId 在手（否则抛 'illegal-pass'）；无状态变更，lastEvents 清空。 */
export function applyPass(
  state: GameState,
  player: PlayerIndex,
  action: Action,
): GameState {
  if (action.type !== 'pass') {
    throw new IllegalActionError('not-a-pass-action', `not-a-pass-action: ${action.type}`);
  }
  if (!state.players[player]!.hand.some((c) => c.id === action.cardId)) {
    throw new IllegalActionError(
      'illegal-pass',
      `illegal-pass: card ${action.cardId} not in player ${player}'s hand`,
    );
  }
  return { ...state, lastEvents: [] };
}
