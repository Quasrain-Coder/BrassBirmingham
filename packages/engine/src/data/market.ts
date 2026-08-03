/**
 * 市场数值常量。逐行转录自 docs/rules-reference.md §5（[B] 市场区目视 + [R p.4, p.8]）。
 * 市场格按价格升序排列；买从最便宜格起取，卖从最贵空格起填。
 */
import type { Era } from '../types.js';

/** 煤市场 14 格：£1×2 … £7×2（索引 0 最便宜）。 */
export const COAL_MARKET_PRICES: readonly number[] = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7];
/** 设置时放 13 块煤（留 1 个 £1 格空）。 */
export const COAL_MARKET_INITIAL_FILLED = 13;
/** 市场买空后的兜底价 £8/块（仍需连通任一商人位图标）。 */
export const COAL_FALLBACK_PRICE = 8;

/** 铁市场 10 格：£1×2 … £5×2（索引 0 最便宜）。 */
export const IRON_MARKET_PRICES: readonly number[] = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
/** 设置时放 8 块铁（留 2 个 £1 格空）。 */
export const IRON_MARKET_INITIAL_FILLED = 8;
/** 市场买空后的兜底价 £6/块（买铁无需连通）。 */
export const IRON_FALLBACK_PRICE = 6;

/** 酿酒厂建成放桶数：按时代而非等级——运河时代 1 桶，铁路时代 2 桶 [R p.9]。 */
export const BREWERY_BARRELS: Record<Era, number> = { canal: 1, rail: 2 };
