import type { GameState, PlayerIndex } from '@brass/engine';
import type { FilteredPlayerState, FilteredState } from './index.js';

/**
 * 按座位视角过滤 GameState（隐藏信息裁剪）：
 * - viewer 自己的 hand 完整（kind: 'full'），他人只剩张数（kind: 'count'）；
 * - deck/discard 只露数量，弃牌堆顶公开（Brass 规则中弃牌堆顶可见）；
 * - rngState 移除，防客户端推算洗牌序。
 * 不改原 state（顶层浅拷贝 + players/hand 换壳，其余子对象共享只读引用）。
 */
export function filterStateFor(state: GameState, viewer: PlayerIndex): FilteredState {
  const { players, deck, discard, rngState: _rngState, ...rest } = state;
  const filteredPlayers: FilteredPlayerState[] = players.map((p, i) => ({
    ...p,
    hand:
      i === viewer
        ? { kind: 'full', cards: [...p.hand] }
        : { kind: 'count', count: p.hand.length },
  }));
  return {
    ...rest,
    players: filteredPlayers,
    deck: { count: deck.length },
    discard: {
      count: discard.length,
      top: discard.length > 0 ? discard[discard.length - 1]! : null,
    },
  };
}
