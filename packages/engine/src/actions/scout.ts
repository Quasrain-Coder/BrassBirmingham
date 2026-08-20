/**
 * Scout 侦察行动：枚举 + 执行（rules-reference §6.7，§9.14）。
 *
 * - 弃 3 张卡（1 张行动卡 + 额外 2 张手牌），拿 1 Wild Location + 1 Wild Industry。
 * - 手中已有 Wild 卡不可执行；任一 Wild 供应堆为空不可执行。
 * - 弃哪 3 张有策略意义（甩废卡），枚举全部 C(n,3) 组合，不做组合规范化。
 *
 * 弃牌特例（与其他行动不同）：applyScout 自己处理全部 3 张弃牌——普通卡进弃牌堆，
 * Wild 卡回 Wild 供应堆；Task 11 applyAction 对 scout 不再重复弃牌。
 *
 * 纯函数：不改入参。
 */
import { WILD_INDUSTRY_COUNT, WILD_LOCATION_COUNT, type Card } from '../data/cards.js';
import { IllegalActionError } from '../errors.js';
import type { GameState } from '../state.js';
import type { Action, PlayerIndex } from '../types.js';

function isWild(card: Card): boolean {
  return card.kind === 'wild-location' || card.kind === 'wild-industry';
}

/**
 * 枚举 Scout 行动：手牌全部 C(n,3) 组合（手牌序，下标升序三元组）。
 * 手有 Wild 或任一 Wild 供应堆为空时为空。
 */
export function enumerateScout(state: GameState, player: PlayerIndex): Action[] {
  const ps = state.players[player]!;
  if (state.wildSupply.location < 1 || state.wildSupply.industry < 1) return [];
  if (ps.hand.some(isWild)) return [];
  const out: Action[] = [];
  for (let i = 0; i < ps.hand.length; i++) {
    for (let j = i + 1; j < ps.hand.length; j++) {
      for (let k = j + 1; k < ps.hand.length; k++) {
        out.push({
          type: 'scout',
          cardIds: [ps.hand[i]!.id, ps.hand[j]!.id, ps.hand[k]!.id],
        });
      }
    }
  }
  return out;
}

/**
 * 执行 Scout：移除 3 张弃牌（普通卡 → 弃牌堆；Wild → 回供应堆），
 * 从供应堆拿 wild-location + wild-industry 各 1 入手。
 * 不在枚举集内抛 'illegal-scout'。
 */
export function applyScout(
  state: GameState,
  player: PlayerIndex,
  action: Action,
): GameState {
  if (action.type !== 'scout') {
    throw new IllegalActionError('not-a-scout-action', `not-a-scout-action: ${action.type}`);
  }
  const legal = enumerateScout(state, player).some(
    (a) =>
      a.type === 'scout' &&
      a.cardIds.length === action.cardIds.length &&
      a.cardIds.every((v, k) => v === action.cardIds[k]),
  );
  if (!legal) {
    throw new IllegalActionError(
      'illegal-scout',
      `illegal-scout: cards [${action.cardIds.join(', ')}]`,
    );
  }

  const ps = state.players[player]!;
  const discardIds = new Set<string>(action.cardIds);
  const discarded = ps.hand.filter((c) => discardIds.has(c.id));
  const kept = ps.hand.filter((c) => !discardIds.has(c.id));

  // 弃牌去向：普通卡进弃牌堆；Wild 卡回供应堆（契约保证不会发生，防御性处理）
  let wildSupply = { ...state.wildSupply };
  const toDiscard: Card[] = [];
  for (const c of discarded) {
    if (c.kind === 'wild-location') wildSupply.location += 1;
    else if (c.kind === 'wild-industry') wildSupply.industry += 1;
    else toDiscard.push(c);
  }

  // 拿两张 Wild。id 取"未在任何玩家手牌中流通"的最小编号（确定性唯一）：
  // 不能用 COUNT - 供应余量——Wild 弃置归还供应堆后可被再次取出，公式会与
  // 仍在其他玩家手中的同种 Wild 撞号。
  const inHands = new Set(
    state.players.flatMap((p) => p.hand.filter(isWild).map((c) => c.id)),
  );
  const takeWildId = (kind: 'wild-location' | 'wild-industry'): string => {
    const count = kind === 'wild-location' ? WILD_LOCATION_COUNT : WILD_INDUSTRY_COUNT;
    for (let i = 0; i < count; i++) {
      const id = `${kind}-${i}`;
      if (!inHands.has(id)) return id;
    }
    // 供应余量 > 0（枚举已校验）⇒ 必有空闲 id，正常不可达
    throw new IllegalActionError('illegal-scout', `illegal-scout: no free ${kind} id`);
  };
  const wildLocation: Card = { id: takeWildId('wild-location'), kind: 'wild-location' };
  const wildIndustry: Card = { id: takeWildId('wild-industry'), kind: 'wild-industry' };
  wildSupply = { location: wildSupply.location - 1, industry: wildSupply.industry - 1 };

  const players = state.players.slice();
  players[player] = { ...ps, hand: [...kept, wildLocation, wildIndustry] };
  return {
    ...state,
    players,
    wildSupply,
    discard: [...state.discard, ...toDiscard],
    lastEvents: [],
  };
}
