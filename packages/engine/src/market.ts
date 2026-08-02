/**
 * 市场买卖结算（rules-reference §5）。
 *
 * 状态字段语义：coalMarket/ironMarket = 当前在市场上的方块数（filled）。
 * filled 块永远占据"最贵 filled 格"（索引 prices.length - filled .. length-1）：
 * - 买：从最便宜已填格（索引 length - filled）起逐格取，买空后按兜底价（煤 £8/铁 £6）。
 * - 卖：从最贵空格（索引 length - filled - 1 向下）起逐格填，空格不足时截断。
 *
 * 全部为纯函数：只算金额/数量，不改 state；连通校验在 network.ts
 * （买煤需 canBuyCoalFromMarket，买铁无需连通 §9.1）。
 */
import {
  COAL_FALLBACK_PRICE,
  COAL_MARKET_PRICES,
  IRON_FALLBACK_PRICE,
  IRON_MARKET_PRICES,
} from './data/market.js';
import type { GameState } from './state.js';

/** 从市场买 n 块的总价：filled 块从最便宜已填格起取，超出部分按 fallback 单价。 */
export function marketBuyCost(
  prices: readonly number[],
  filled: number,
  n: number,
  fallback: number,
): number {
  const fromMarket = Math.min(n, filled);
  const start = prices.length - filled; // 最便宜已填格索引
  let cost = 0;
  for (let i = 0; i < fromMarket; i++) cost += prices[start + i]!;
  return cost + (n - fromMarket) * fallback;
}

/** 向市场卖 n 块：从最贵空格起填；返回收入与实际卖出数（空格不足时截断）。 */
export function marketSellRevenue(
  prices: readonly number[],
  filled: number,
  n: number,
): { revenue: number; sold: number } {
  const empty = prices.length - filled;
  const sold = Math.min(n, empty);
  let revenue = 0;
  for (let i = 0; i < sold; i++) revenue += prices[empty - 1 - i]!;
  return { revenue, sold };
}

/** 买 n 块煤的总价（连通校验另见 canBuyCoalFromMarket）。 */
export function buyCoalCost(state: GameState, n: number): number {
  return marketBuyCost(COAL_MARKET_PRICES, state.coalMarket, n, COAL_FALLBACK_PRICE);
}

/** 买 n 块铁的总价（无需连通，§9.1）。 */
export function buyIronCost(state: GameState, n: number): number {
  return marketBuyCost(IRON_MARKET_PRICES, state.ironMarket, n, IRON_FALLBACK_PRICE);
}

/** 向煤市场卖 n 块（仅建煤矿当次行动且连通商人位时，§5）。 */
export function sellCoalToMarket(
  state: GameState,
  n: number,
): { revenue: number; sold: number } {
  return marketSellRevenue(COAL_MARKET_PRICES, state.coalMarket, n);
}

/** 向铁市场卖 n 块（铁厂建成即卖，无条件，§9.7）。 */
export function sellIronToMarket(
  state: GameState,
  n: number,
): { revenue: number; sold: number } {
  return marketSellRevenue(IRON_MARKET_PRICES, state.ironMarket, n);
}
