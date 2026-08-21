/**
 * applyAction 统一调度（rules-reference §4/§6）：六大行动 + pass 的统一入口。
 *
 * 职责：
 * 1. 合法性校验：action 必须属于 enumerateActions(state, 当前玩家) 的输出（规范化
 * 比较：sell 的 sales 与顺序无关，与各行动模块自身的校验语义一致），否则抛
 * IllegalActionError('illegal-action')；phase==='game-over' 时枚举为空、一切行动非法。
 * 2. 分派到各行动模块（模块内部还会按各自模式重枚举校验一次）。
 * 3. 弃牌分派：build/scout 的弃牌已由各自 apply 处理（scout 弃 3 张），这里**不重复**；
 * network/develop/loan/sell/pass 在此统一弃 action.cardId 那 1 张——Wild 卡回 Wild
 * 供应堆，普通卡进弃牌堆（§9.14）。
 * 4. 补牌：该玩家**本轮全部行动完成后**手牌才从 deck 补回 8 张（规则书 p.6
 *    "After all of your actions have been completed"；2 行动回合的第 1 个行动后
 *    不补——第 2 个行动只能用剩余的 7 张）；deck 空则不补（§4）。
 * 5. 行动计数 actionsThisTurn++；spentThisRound 各模块已累加（含市场买卖现金）。
 * 6. lastEvents 统一写 GameState.lastEvents：返回 GameState 的模块自己已写；
 * 返回 {state, events} 的模块（build/sell）在此转写。
 * 7. 末尾调 endTurnIfNeeded 推进回合/轮结构。
 *
 * 纯函数：不改入参。
 */
import { applyBuild, enumerateBuilds } from './actions/build.js';
import { applyDevelop, enumerateDevelop } from './actions/develop.js';
import { applyLoan, enumerateLoan } from './actions/loan.js';
import { applyNetwork, enumerateNetwork } from './actions/network.js';
import { applyPass } from './actions/pass.js';
import { applyScout, enumerateScout } from './actions/scout.js';
import { applySell, enumerateSells, validateSales } from './actions/sell.js';
import { IllegalActionError } from './errors.js';
import { stableStringify } from './serialize.js';
import type { GameState, PlayerState } from './state.js';
import { actionsPerRound, endTurnIfNeeded } from './turn.js';
import type { Action, PlayerIndex } from './types.js';

const HAND_SIZE = 8;

/**
 * 六大行动 + pass 的汇总枚举（pass 无独立模块枚举，按手牌逐张构造）。
 * 顺序确定性：build → network → develop → sell → loan → scout → pass（手牌序）。
 * phase==='game-over' 返回 []。
 */
export function enumerateActions(state: GameState, player: PlayerIndex): Action[] {
  if (state.phase === 'game-over') return [];
  const ps = state.players[player]!;
  const passes: Action[] = ps.hand.map((c) => ({ type: 'pass', cardId: c.id }));
  return [
    ...enumerateBuilds(state, player),
    ...enumerateNetwork(state, player),
    ...enumerateDevelop(state, player),
    ...enumerateSells(state, player),
    ...enumerateLoan(state, player),
    ...enumerateScout(state, player),
    ...passes,
  ];
}

type SellAction = Extract<Action, { type: 'sell' }>;
type Sale = SellAction['sales'][number];

/** 与 sell.ts sameSales 相同的排序键。 */
function saleKey(s: Sale): string {
  return `${s.location} ${s.slotIndex} ${s.merchant} ${s.useMerchantBeer ? 1 : 0}`;
}

/**
 * 规范化：build 剥离 slotIndex（apply-only 的显式槽位选择,枚举从不产出——合法性
 * 由 applyBuild 的 illegal-build-slot 另行校验）；sell 的 sales 排序（顺序无关）并
 * 剥离 beerSources（apply-only 的显式啤酒来源）；network 剥离 beerFromOpponentBrewery
 * （同前例）；其余行动原样（scout cardIds 顺序有语义）。
 */
function normalizeAction(action: Action): Action {
  if (action.type === 'network') {
    const { beerFromOpponentBrewery: _ignored, ...rest } = action;
    return rest;
  }
  if (action.type === 'build') {
    const { slotIndex: _ignored, ...rest } = action;
    return rest;
  }
  if (action.type !== 'sell') return action;
  return {
    ...action,
    sales: action.sales
      .map(({ beerSources: _ignored, ...s }) => s)
      .sort((a, b) => (saleKey(a) < saleKey(b) ? -1 : 1)),
  };
}

/** 规范化比较：action 是否在 enumerateActions 输出内。sell 走组合式校验(自定义组合)。 */
function isLegalAction(state: GameState, player: PlayerIndex, action: Action): boolean {
  if (action.type === 'sell') {
    // 组合式校验(applySell 同一套):行动卡须在手 + 逐块合法 + 啤酒可行
    if (!state.players[player]!.hand.some((c) => c.id === action.cardId)) return false;
    try {
      validateSales(state, player, action);
      return true;
    } catch {
      return false;
    }
  }
  const target = stableStringify(normalizeAction(action));
  return enumerateActions(state, player).some(
    (a) => stableStringify(normalizeAction(a)) === target,
  );
}

/** 替换某玩家的 PlayerState（结构共享）。 */
function withPlayer(state: GameState, player: PlayerIndex, p: PlayerState): GameState {
  const players = state.players.slice();
  players[player] = p;
  return { ...state, players };
}

/** 统一弃 1 张行动卡：Wild 回供应堆，普通卡进弃牌堆。 */
function discardActionCard(state: GameState, player: PlayerIndex, cardId: string): GameState {
  const ps = state.players[player]!;
  const idx = ps.hand.findIndex((c) => c.id === cardId);
  if (idx < 0) {
    // 合法性校验已通过，正常不可达（防御）
    throw new IllegalActionError(
      'illegal-action',
      `illegal-action: card ${cardId} not in player ${player}'s hand`,
    );
  }
  const card = ps.hand[idx]!;
  let next = withPlayer(state, player, {
    ...ps,
    hand: [...ps.hand.slice(0, idx), ...ps.hand.slice(idx + 1)],
  });
  if (card.kind === 'wild-location') {
    next = { ...next, wildSupply: { ...next.wildSupply, location: next.wildSupply.location + 1 } };
  } else if (card.kind === 'wild-industry') {
    next = { ...next, wildSupply: { ...next.wildSupply, industry: next.wildSupply.industry + 1 } };
  } else {
    next = { ...next, discard: [...next.discard, card] };
  }
  return next;
}

/** 手牌从 deck 顶补回 8 张；deck 空则不补。 */
function refillHand(state: GameState, player: PlayerIndex): GameState {
  const ps = state.players[player]!;
  const draw = Math.min(HAND_SIZE - ps.hand.length, state.deck.length);
  if (draw <= 0) return state;
  const players = state.players.slice();
  players[player] = { ...ps, hand: [...ps.hand, ...state.deck.slice(0, draw)] };
  return { ...state, players, deck: state.deck.slice(draw) };
}

/**
 * 统一行动入口：校验 → 分派 → 弃牌（按行动类型分派）→ 行动计数 →
 * （本轮最后一次行动时）补牌 → 回合推进。
 * 不在枚举集内抛 IllegalActionError('illegal-action')。
 */
export function applyAction(state: GameState, action: Action): GameState {
  const player = state.turnOrder[state.currentPlayerIdx]!;
  if (!isLegalAction(state, player, action)) {
    throw new IllegalActionError(
      'illegal-action',
      `illegal-action: ${stableStringify(action)} for player ${player}`,
    );
  }

  let next: GameState;
  switch (action.type) {
    case 'build': {
      // build 自己已弃 1 卡
      const r = applyBuild(state, player, action);
      next = { ...r.state, lastEvents: r.events };
      break;
    }
    case 'sell': {
      const r = applySell(state, player, action);
      next = discardActionCard({ ...r.state, lastEvents: r.events }, player, action.cardId);
      break;
    }
    case 'network':
      next = discardActionCard(applyNetwork(state, player, action), player, action.cardId);
      break;
    case 'develop':
      next = discardActionCard(applyDevelop(state, player, action), player, action.cardId);
      break;
    case 'loan':
      next = discardActionCard(applyLoan(state, player, action), player, action.cardId);
      break;
    case 'pass':
      next = discardActionCard(applyPass(state, player, action), player, action.cardId);
      break;
    case 'scout':
      // scout 自己已弃 3 卡
      next = applyScout(state, player, action);
      break;
  }

  // 补牌时机（规则书 p.6 "After all of your actions have been completed"）：
  // 仅本轮最后一次行动后补回 8 张；2 行动回合的第 1 个行动后手牌保持 7 张。
  if (next.actionsThisTurn + 1 >= actionsPerRound(next)) {
    next = refillHand(next, player);
  }
  next = { ...next, actionsThisTurn: next.actionsThisTurn + 1 };
  return endTurnIfNeeded(next);
}
