/**
 * 回合/轮结构（rules-reference §4，[R p.6]）。
 *
 * - 每名玩家每轮行动数：运河时代 round 1 = 1，其他轮 = 2（含铁路时代 round 1）。
 *   applyAction 累加 actionsThisTurn 后调 endTurnIfNeeded：满员则推进 currentPlayerIdx。
 * - 一轮结束（turnOrder 全员行动完）结算，顺序固定：
 *   a. 按 spentThisRound 升序重排 turnOrder（稳定排序，并列保持相对顺序），
 *      spentThisRound 归零（角色块上的钱放回银行）；
 *   b. 发收入：等级正 → 银行取钱；负 → 付钱，现金不足时半价（向下取整）拆自己场上
 *      板块变现、够付即停，仍不足每缺 £1 扣 1 VP（VP 可为负）；
 *   c. **例外：全局最后一轮（铁路时代末轮）结束后不发收入**；运河时代末轮正常发
 *      （规则书原文例外仅限 "final round of the game"）；
 *   d. round++；时代结束条件（eraEndCondition：牌堆空且全部手牌空）满足时置
 *      eraEndPending = true，并立即调 era.ts 的 checkEraEnd 消费——运河末清算进
 *      铁路时代，铁路末终局计分进 game-over（返回态 eraEndPending 复归 false）。
 * - 无牌自动跳过（deck 空时）：当前玩家手牌打空即视为行动完成直接推进；推进后
 *   若下一位玩家手牌为空也一并跳过（scout 净 -2 手牌可致末轮手牌错位，否则该
 *   玩家 enumerateActions=[] 游戏死锁）。跳过不耗行动数、该玩家本轮不再行动。
 *
 * 负收入拆板块的规范化（v1 原子结算，玩家无可选）：按"变现额升序 → LocationId 字典序
 * → 槽位序"逐块拆除；变现 £0 的板块（pottery II/IV 成本 £0）不参与拆除（不能减少亏空）。
 *
 * 纯函数：不改入参。
 */
import { incomeLevelAt } from './data/income.js';
import { checkEraEnd } from './era.js';
import type { GameState, PlayerState } from './state.js';
import type { LocationId, PlayerIndex } from './types.js';

/** 当前轮每名玩家的行动数：运河时代 round 1 = 1，其余 = 2。 */
export function actionsPerRound(state: GameState): number {
  return state.era === 'canal' && state.round === 1 ? 1 : 2;
}

/** 时代结束条件（§4）：牌堆空且全部玩家手牌空。 */
export function eraEndCondition(state: GameState): boolean {
  return state.deck.length === 0 && state.players.every((p) => p.hand.length === 0);
}

/**
 * deck 空时的无牌跳过：从 currentPlayerIdx 起，跳过手牌为空的玩家
 * （时代清算后手牌重抽、终局 phase='game-over'，均不会误跳）。
 */
function skipCardlessPlayers(state: GameState): GameState {
  if (state.phase === 'game-over' || state.deck.length > 0) return state;
  let idx = state.currentPlayerIdx;
  while (idx < state.playerCount && state.players[state.turnOrder[idx]!]!.hand.length === 0) {
    idx++;
  }
  return idx === state.currentPlayerIdx ? state : { ...state, currentPlayerIdx: idx };
}

/** 替换某玩家的 PlayerState（结构共享）。 */
function withPlayer(state: GameState, player: PlayerIndex, p: PlayerState): GameState {
  const players = state.players.slice();
  players[player] = p;
  return { ...state, players };
}

/** 负收入时下一个被变现拆除的板块（规范化顺序；null = 无可拆）。 */
function nextLiquidation(
  state: GameState,
  player: PlayerIndex,
): { location: LocationId; slotIndex: number; value: number } | null {
  let best: { location: LocationId; slotIndex: number; value: number } | null = null;
  for (const [location, slots] of Object.entries(state.board.slots)) {
    for (let i = 0; i < slots.length; i++) {
      const t = slots[i];
      if (!t || t.player !== player) continue;
      const value = Math.floor(t.tile.costMoney / 2);
      if (value <= 0) continue; // £0 板块不能减少亏空，不拆
      if (
        !best ||
        value < best.value ||
        (value === best.value &&
          (location < best.location ||
            (location === best.location && i < best.slotIndex)))
      ) {
        best = { location, slotIndex: i, value };
      }
    }
  }
  return best;
}

/** 拆除一块场上板块（连同资源退出游戏）并给 owner 变现金。 */
function liquidate(
  state: GameState,
  player: PlayerIndex,
  target: { location: LocationId; slotIndex: number; value: number },
): GameState {
  const slots = state.board.slots[target.location]!.slice();
  slots[target.slotIndex] = null;
  let next: GameState = {
    ...state,
    board: { ...state.board, slots: { ...state.board.slots, [target.location]: slots } },
  };
  const ps = next.players[player]!;
  return withPlayer(next, player, { ...ps, money: ps.money + target.value });
}

/** 负收入：现金 → 拆板块（够付即停）→ VP 兜底（每缺 £1 扣 1 VP，可为负）。 */
function payNegativeIncome(state: GameState, player: PlayerIndex, owed: number): GameState {
  let next = state;
  while (next.players[player]!.money < owed) {
    const target = nextLiquidation(next, player);
    if (!target) break;
    next = liquidate(next, player, target);
  }
  const ps = next.players[player]!;
  const paid = Math.min(ps.money, owed);
  const deficit = owed - paid;
  return withPlayer(next, player, {
    ...ps,
    money: ps.money - paid,
    vp: ps.vp - deficit,
  });
}

/** 全员收入结算（按玩家下标序，确定性；玩家间互不影响）。 */
function settleIncome(state: GameState): GameState {
  let next = state;
  for (let p = 0; p < next.playerCount; p++) {
    const level = incomeLevelAt(next.players[p]!.incomeSpace);
    if (level > 0) {
      const ps = next.players[p]!;
      next = withPlayer(next, p, { ...ps, money: ps.money + level });
    } else if (level < 0) {
      next = payNegativeIncome(next, p, -level);
    }
  }
  return next;
}

/**
 * 当前玩家行动数满则推进：换人；一轮结束则按模块头注释 a–d 结算。
 * 未满原样返回。applyAction 在行动计数 +1 后调用；也可单独调用（测试/调试）。
 */
export function endTurnIfNeeded(state: GameState): GameState {
  // 无牌自动跳过：deck 空且当前玩家手牌打空 → 视为行动完成，直接推进
  const current = state.players[state.turnOrder[state.currentPlayerIdx]!]!;
  const currentCardless = state.deck.length === 0 && current.hand.length === 0;
  if (!currentCardless && state.actionsThisTurn < actionsPerRound(state)) return state;
  let next: GameState = {
    ...state,
    actionsThisTurn: 0,
    currentPlayerIdx: state.currentPlayerIdx + 1,
  };
  next = skipCardlessPlayers(next);
  if (next.currentPlayerIdx < next.playerCount) return next;

  // 一轮结束
  const eraEnd = eraEndCondition(next);
  const finalRoundOfGame = eraEnd && next.era === 'rail';

  // a. 顺位重排（稳定：spent 升序，并列保持本轮相对顺序），spent 归零
  const ranked = next.turnOrder.map((p, i) => ({
    p,
    i,
    spent: next.players[p]!.spentThisRound,
  }));
  ranked.sort((x, y) => x.spent - y.spent || x.i - y.i);
  next = {
    ...next,
    turnOrder: ranked.map((r) => r.p),
    players: next.players.map((ps) => ({ ...ps, spentThisRound: 0 })),
  };

  // b. 收入（c 例外：全局最后一轮不发）
  if (!finalRoundOfGame) next = settleIncome(next);

  // d. round++；时代结束置位并立即清算（era.ts checkEraEnd 消费）
  next = {
    ...next,
    currentPlayerIdx: 0,
    round: next.round + 1,
    ...(eraEnd ? { eraEndPending: true } : {}),
  };
  if (eraEnd) return checkEraEnd(next);
  // 新一轮起始玩家同样可能无牌（deck 空 + scout 错位）
  return skipCardlessPlayers(next);
}
