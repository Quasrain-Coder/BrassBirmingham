import { describe, expect, it } from 'vitest';
import { newGame } from '../src/state.js';
import {
  buyCoalCost,
  buyIronCost,
  marketBuyCost,
  marketSellRevenue,
  sellCoalToMarket,
  sellIronToMarket,
} from '../src/market.js';
import {
  COAL_MARKET_PRICES,
  IRON_MARKET_PRICES,
} from '../src/data/market.js';

describe('marketBuyCost / marketSellRevenue 纯函数', () => {
  it('buy n=0 costs 0; sell n=0 sells nothing', () => {
    expect(marketBuyCost(COAL_MARKET_PRICES, 13, 0, 8)).toBe(0);
    expect(marketSellRevenue(COAL_MARKET_PRICES, 13, 0)).toEqual({ revenue: 0, sold: 0 });
  });

  it('sell caps at empty spaces; buy falls back after market empties', () => {
    // 煤 14 格填 13 → 仅 1 空格
    expect(marketSellRevenue(COAL_MARKET_PRICES, 13, 5)).toEqual({ revenue: 1, sold: 1 });
    // 填 1 → 最贵已填格 £7，再买 2 块走兜底
    expect(marketBuyCost(COAL_MARKET_PRICES, 1, 3, 8)).toBe(7 + 8 + 8);
  });
});

describe('buyCoalCost / buyIronCost', () => {
  it('buy coal: cheapest first, fallback £8 when empty', () => {
    const s = newGame(4, 1); // 13 块：£1×1, £2×2, ...
    expect(buyCoalCost(s, 1)).toBe(1);
    expect(buyCoalCost(s, 3)).toBe(1 + 2 + 2);
    s.coalMarket = 0;
    expect(buyCoalCost(s, 2)).toBe(16);
  });

  it('buy coal: partial market then fallback mixed', () => {
    const s = newGame(4, 1);
    s.coalMarket = 1; // 仅剩最贵格 £7
    expect(buyCoalCost(s, 2)).toBe(7 + 8);
  });

  it('buy iron: cheapest first; fallback £6, no connectivity required', () => {
    const s = newGame(4, 1); // 8 块：空格 £1×2，已填 £2×2..£5×2
    expect(buyIronCost(s, 1)).toBe(2);
    expect(buyIronCost(s, 2)).toBe(2 + 2);
    expect(buyIronCost(s, 9)).toBe(2 + 2 + 3 + 3 + 4 + 4 + 5 + 5 + 6);
    s.ironMarket = 0;
    expect(buyIronCost(s, 1)).toBe(6);
  });

  it('cost helpers are pure (do not mutate market state)', () => {
    const s = newGame(4, 1);
    buyCoalCost(s, 5);
    buyIronCost(s, 5);
    expect(s.coalMarket).toBe(13);
    expect(s.ironMarket).toBe(8);
  });
});

describe('sellCoalToMarket / sellIronToMarket', () => {
  it('sell iron fills most-expensive empty space first', () => {
    const s = newGame(4, 1); // 铁市场 8 块 → 空格 £1×2
    expect(sellIronToMarket(s, 1)).toEqual({ revenue: 1, sold: 1 });
    s.ironMarket = 0; // 全空 → 最贵空格 £5
    expect(sellIronToMarket(s, 2)).toEqual({ revenue: 10, sold: 2 });
  });

  it('sell coal caps at empty spaces', () => {
    const s = newGame(4, 1); // 煤 13/14 → 仅 1 个 £1 空格
    expect(sellCoalToMarket(s, 3)).toEqual({ revenue: 1, sold: 1 });
    s.coalMarket = 12; // 空格 £1×2
    expect(sellCoalToMarket(s, 2)).toEqual({ revenue: 2, sold: 2 });
  });

  it('sell fills from most-expensive empty: partial fill order', () => {
    const s = newGame(4, 1);
    s.ironMarket = 9; // 空格仅 £1 一格
    expect(sellIronToMarket(s, 1)).toEqual({ revenue: 1, sold: 1 });
    s.ironMarket = 7; // 空格 £1×2, £2×1（索引 0..2）→ 最贵空格 £2
    expect(sellIronToMarket(s, 1)).toEqual({ revenue: 2, sold: 1 });
  });

  it('sell helpers are pure (do not mutate market state)', () => {
    const s = newGame(4, 1);
    sellCoalToMarket(s, 2);
    sellIronToMarket(s, 2);
    expect(s.coalMarket).toBe(13);
    expect(s.ironMarket).toBe(8);
  });

  it('prices arrays sanity: lengths used by helpers', () => {
    expect(COAL_MARKET_PRICES).toHaveLength(14);
    expect(IRON_MARKET_PRICES).toHaveLength(10);
  });
});
