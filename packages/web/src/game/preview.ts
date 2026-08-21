/**
 * 行动收益预览:在确认行动前,显示该行动的预计收益(收入格/VP/钱)与花费(£/煤/铁/酒)。
 * 数据全部来自公开状态(FilteredState 结构上与 GameState 一致的部分)+ 引擎公开 helper,
 * 与引擎实际结算一致(煤免费源/市场价序、翻面收入、商人奖励)。
 */
import type { Action, IndustryType, LocationId, PlayerIndex } from '@brass/engine';
import {
  LINKS,
  LOCATIONS,
  MERCHANTS,
  TILES,
  buyCoalCost,
  buyIronCost,
  canBuyCoalFromMarket,
  coalSources,
  ironSources,
  sellCoalToMarket,
  sellIronToMarket,
} from '@brass/engine';
import type { GameState, PlacedTile } from '@brass/engine';
import type { FilteredState } from '@brass/protocol';
import { industryName, locationName, merchantName } from './display';

/** FilteredState 在 helper 关心的字段上与 GameState 同构(board/市场/era/players)。 */
function asGameState(state: FilteredState): GameState {
  return state as unknown as GameState;
}

export interface ActionPreview {
  /** 收益文案(收入格前进/VP/收钱/资源收入)。 */
  gains: string[];
  /** 花费文案(£/煤/铁/啤酒)。 */
  costs: string[];
}

function merchantBonusText(merchant: keyof typeof MERCHANTS): string {
  const b = MERCHANTS[merchant].bonus;
  switch (b.type) {
    case 'vp':
      return `+${b.amount} VP`;
    case 'money':
      return `+£${b.amount}`;
    case 'income':
      return `收入 +${b.amount} 格`;
    case 'develop':
      return '免费研发 1 块';
  }
}

/** 建造成本分解(煤:免费源不足才按市价,需连通商人位;铁:免费源不足按市价,无需连通)。 */
function buildCosts(state: FilteredState, player: PlayerIndex, location: LocationId, def: (typeof TILES)[number]): string[] {
  const gs = asGameState(state);
  const costs: string[] = [`£${def.costMoney}`];
  if (def.costCoal > 0) {
    const free = coalSources(gs, player, location).reduce((s, x) => s + x.tile.resources, 0);
    const need = def.costCoal - free;
    const parts = [`煤×${def.costCoal}`];
    if (need > 0) parts.push(`市价 £${buyCoalCost(gs, need)}`);
    else parts.push('免费');
    costs.push(parts.join('(') + ')');
  }
  if (def.costIron > 0) {
    const free = ironSources(gs).reduce((s, x) => s + x.tile.resources, 0);
    const need = def.costIron - free;
    const parts = [`铁×${def.costIron}`];
    if (need > 0) parts.push(`市价 £${buyIronCost(gs, need)}`);
    else parts.push('免费');
    costs.push(parts.join('(') + ')');
  }
  return costs;
}

/** 建成即卖市场的收益(煤须连通商人位、铁无条件;卖空即翻面进收入)。 */
function buildMarketGains(state: FilteredState, industry: IndustryType, location: LocationId, def: (typeof TILES)[number]): string[] {
  const gs = asGameState(state);
  const gains: string[] = [];
  const sellable = industry === 'iron' || (industry === 'coal' && canBuyCoalFromMarket(gs, location));
  if ((industry === 'coal' || industry === 'iron') && sellable) {
    gains.push('方块卖市场收钱');
    if (def.resourcesPlaced <= 2) gains.push(`卖空翻面:收入 +${def.incomeAdvance} 格`);
  }
  return gains;
}

export function previewOf(action: Action, state: FilteredState, player: PlayerIndex): ActionPreview {
  const gains: string[] = [];
  const costs: string[] = [];
  const gs = asGameState(state);
  switch (action.type) {
    case 'build': {
      const def = state.players[player]!.tiles.find((t) => t.industry === action.industry);
      if (def === undefined) break;
      costs.push(...buildCosts(state, player, action.location, def));
      gains.push(...buildMarketGains(state, action.industry, action.location, def));
      break;
    }
    case 'sell': {
      for (const sale of action.sales) {
        const placed = state.board.slots[sale.location]?.[sale.slotIndex] as PlacedTile | null | undefined;
        if (placed == null) continue;
        gains.push(`${locationName(sale.location)}翻面:收入 +${placed.tile.incomeAdvance} 格`);
        if (sale.useMerchantBeer) {
          gains.push(`${merchantName(sale.merchant)}奖励:${merchantBonusText(sale.merchant)}`);
          costs.push(`${merchantName(sale.merchant)}桶×1`);
        }
        if (placed.tile.beerToFlip > 1) costs.push(`啤酒×${placed.tile.beerToFlip}`);
        else if (placed.tile.beerToFlip === 1 && !sale.useMerchantBeer) costs.push('啤酒×1');
      }
      break;
    }
    case 'network': {
      if (state.era === 'canal') {
        costs.push('£3');
      } else {
        costs.push(action.links.length === 2 ? '£15 + 啤酒×1(须酒厂)' : '£5');
        // 每条铁路 1 煤,逐条放置后判定:就近连通煤矿免费,不足且连通商人位则市价
        costs.push(`煤×${action.links.length}(就近免费源优先,不足市价)`);
      }
      break;
    }
    case 'develop': {
      const free = ironSources(gs).reduce((s, x) => s + x.tile.resources, 0);
      const need = action.removals.length - free;
      costs.push(
        `铁×${action.removals.length}` + (need > 0 ? `(市价 £${buyIronCost(gs, need)})` : '(免费)'),
      );
      gains.push('解锁更高等级板块');
      break;
    }
    case 'loan': {
      gains.push('+£30');
      costs.push('收入等级 −3');
      break;
    }
    case 'scout': {
      gains.push('换 2 张百搭');
      costs.push('弃 3 张');
      break;
    }
    case 'pass':
      break;
  }
  return { gains, costs };
}

/**
 * 行动的现金变化量（行动条"现金实时标记"用）：与 previewOf 同源的数值版。
 * 确认/取消/重置时该值即归零,显示回归实际现金(server 快照)。
 * - build:−(印刷 £+煤铁市价补差)+建成即卖市场收入(铁无条件,煤须连通商人位);
 * - network:运河 −£3;铁路 −£5/−£15,每联 1 煤按建造地点连通近似(免费源优先);
 * - develop:−铁的市价补差;loan:+£30;其余 0。
 */
export function moneyDelta(action: Action, state: FilteredState, player: PlayerIndex): number {
  const gs = asGameState(state);
  switch (action.type) {
    case 'build': {
      const def = state.players[player]!.tiles.find((t) => t.industry === action.industry);
      if (def === undefined) return 0;
      let delta = -def.costMoney;
      if (def.costCoal > 0) {
        const free = coalSources(gs, player, action.location).reduce((s, x) => s + x.tile.resources, 0);
        const need = def.costCoal - free;
        if (need > 0) delta -= buyCoalCost(gs, need);
      }
      if (def.costIron > 0) {
        const free = ironSources(gs).reduce((s, x) => s + x.tile.resources, 0);
        const need = def.costIron - free;
        if (need > 0) delta -= buyIronCost(gs, need);
      }
      const sellable =
        def.industry === 'iron' ||
        (def.industry === 'coal' && canBuyCoalFromMarket(gs, action.location));
      if ((def.industry === 'coal' || def.industry === 'iron') && sellable) {
        const sale =
          def.industry === 'coal'
            ? sellCoalToMarket(gs, def.resourcesPlaced)
            : sellIronToMarket(gs, def.resourcesPlaced);
        delta += sale.revenue;
      }
      return delta;
    }
    case 'network': {
      if (state.era === 'canal') return -3;
      let delta = action.links.length === 2 ? -15 : -5;
      for (const linkIdx of action.links) {
        const l = LINKS[linkIdx];
        if (l === undefined) continue;
        // 近似:取边的首个真实城市端点判定煤源/市场连通(农场/商人端点跳过)
        const at = [l.a, l.b].find((x): x is LocationId => x in LOCATIONS);
        if (at === undefined) continue;
        const free = coalSources(gs, player, at).reduce((s, x) => s + x.tile.resources, 0);
        if (free < 1 && canBuyCoalFromMarket(gs, at)) delta -= buyCoalCost(gs, 1);
      }
      return delta;
    }
    case 'develop': {
      const free = ironSources(gs).reduce((s, x) => s + x.tile.resources, 0);
      const need = action.removals.length - free;
      return need > 0 ? -buyIronCost(gs, need) : 0;
    }
    case 'loan':
      return 30;
    default:
      return 0;
  }
}
