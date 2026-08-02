/**
 * Loan 贷款行动：枚举 + 执行（rules-reference §6.6，§9.8）。
 *
 * - 弃 1 卡（弃牌结算在 Task 11 applyAction）；取 £30；收入标记**后退 3 个收入等级**
 *   （不是格），落在新等级的最高格（loanBacktrack，data/income.ts）。
 * - 「不得使收入等级低于 −10」按**禁止**理解：当前等级 ≤ −8 时（退 3 级会破底）
 *   不可贷款（不枚举，apply 抛 'illegal-loan'）；当前等级 −7 时可贷，落到 −10。
 *   loanBacktrack 的 clamp 仅作防御保留。
 *
 * 纯函数：不改入参。
 */
import { INCOME_LEVEL_MIN, incomeLevelAt, loanBacktrack } from '../data/income.js';
import { IllegalActionError } from '../errors.js';
import type { GameState } from '../state.js';
import type { Action, PlayerIndex } from '../types.js';

const LOAN_AMOUNT = 30;

/** 枚举 Loan 行动：手牌每张卡一个；当前等级 ≤ −8（退 3 级会破 −10 底）时为空。 */
export function enumerateLoan(state: GameState, player: PlayerIndex): Action[] {
  const ps = state.players[player]!;
  if (incomeLevelAt(ps.incomeSpace) - 3 < INCOME_LEVEL_MIN) return [];
  return ps.hand.map((c) => ({ type: 'loan', cardId: c.id }));
}

/** 执行 Loan：+£30，收入退 3 级落新等级最高格。不在枚举集内抛 'illegal-loan'。 */
export function applyLoan(
  state: GameState,
  player: PlayerIndex,
  action: Action,
): GameState {
  if (action.type !== 'loan') {
    throw new IllegalActionError('not-a-loan-action', `not-a-loan-action: ${action.type}`);
  }
  const legal = enumerateLoan(state, player).some(
    (a) => a.type === 'loan' && a.cardId === action.cardId,
  );
  if (!legal) {
    throw new IllegalActionError(
      'illegal-loan',
      `illegal-loan: card ${action.cardId} (income space ${state.players[player]!.incomeSpace})`,
    );
  }
  const ps = state.players[player]!;
  const players = state.players.slice();
  players[player] = {
    ...ps,
    money: ps.money + LOAN_AMOUNT,
    incomeSpace: loanBacktrack(ps.incomeSpace),
  };
  return { ...state, players, lastEvents: [] };
}
