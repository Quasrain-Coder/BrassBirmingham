/**
 * 宽屏布局辅助(27 寸显示器全屏):地图居中,左/右两列各放玩家面板(全部铺开,
 * 面板图/明细双模式与经典布局一致),面板顶部两行收口顺位/钱/本回合操作/出牌/
 * 历史下拉。地图底下是我方手牌与行动。
 */
import type { FilteredState } from '@brass/protocol';

/** 本轮每玩家行动数(运河首轮 1,其余 2)。 */
function actionsPerRound(state: FilteredState): number {
  return state.era === 'canal' && state.round === 1 ? 1 : 2;
}

/** 本回合开始 seq(当前快照 seq 回推本回合已行动数)。 */
export function roundStartSeq(state: FilteredState, seq: number): number {
  const played = state.currentPlayerIdx * actionsPerRound(state) + state.actionsThisTurn;
  return Math.max(0, seq - played);
}
