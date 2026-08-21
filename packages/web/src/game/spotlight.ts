/**
 * 行动聚光灯推导：从 action_applied 的 action 导出棋盘高亮目标。
 * 无棋盘目标的行动（develop/loan/scout/pass）返回空数组——只播横幅文字。
 */
import type { Action, PlayerIndex } from '@brass/engine';
import type { ActionSpotlight } from '../board/BoardSvg';

export function spotlightOf(player: PlayerIndex, action: Action): ActionSpotlight {
  switch (action.type) {
    case 'build':
      return { player, locations: [action.location], links: [] };
    case 'network':
      return { player, locations: [], links: [...action.links] };
    case 'sell':
      return {
        player,
        locations: [...new Set(action.sales.map((s) => s.location))],
        links: [],
      };
    default:
      return { player, locations: [], links: [] };
  }
}

/** 单条播报展示时长（ms）：约 5 秒。行动聚光灯/轮次播报串行播放，后来的排队等播完。 */
export const SPOTLIGHT_DURATION_MS = 5000;
