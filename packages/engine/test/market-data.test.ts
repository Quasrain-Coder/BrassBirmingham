import { describe, it, expect } from 'vitest';
import {
  COAL_MARKET_PRICES,
  COAL_MARKET_INITIAL_FILLED,
  COAL_FALLBACK_PRICE,
  IRON_MARKET_PRICES,
  IRON_MARKET_INITIAL_FILLED,
  IRON_FALLBACK_PRICE,
  BREWERY_BARRELS,
} from '../src/data/market.js';

describe('market constants (rules-reference §5)', () => {
  it('coal 14 spaces £1-7 pairs; iron 10 spaces £1-5 pairs', () => {
    expect(COAL_MARKET_PRICES).toHaveLength(14);
    expect(IRON_MARKET_PRICES).toHaveLength(10);
  });
  it('exact price arrays', () => {
    expect(COAL_MARKET_PRICES).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
    expect(IRON_MARKET_PRICES).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
  it('initial fill: coal 13 (one £1 space empty), iron 8 (two £1 spaces empty)', () => {
    expect(COAL_MARKET_INITIAL_FILLED).toBe(13);
    expect(IRON_MARKET_INITIAL_FILLED).toBe(8);
  });
  it('fallback prices when market is empty: coal £8, iron £6', () => {
    expect(COAL_FALLBACK_PRICE).toBe(8);
    expect(IRON_FALLBACK_PRICE).toBe(6);
  });
  it('brewery barrels placed depend on era, not level: canal 1, rail 2', () => {
    expect(BREWERY_BARRELS).toEqual({ canal: 1, rail: 2 });
  });
});
