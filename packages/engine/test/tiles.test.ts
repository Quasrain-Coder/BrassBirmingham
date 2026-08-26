import { describe, it, expect } from 'vitest';
import { TILES } from '../src/data/tiles.js';

describe('tile definitions (rules-reference §2)', () => {
  it('45 tiles per player with rulebook distribution', () => {
    expect(TILES.reduce((s, t) => s + t.count, 0)).toBe(45);
    const by = (i: string) => TILES.filter((t) => t.industry === i).reduce((s, t) => s + t.count, 0);
    expect(by('cotton')).toBe(11);
    expect(by('manufacturer')).toBe(11);
    expect(by('brewery')).toBe(7);
    expect(by('pottery')).toBe(5);
    expect(by('iron')).toBe(4);
    expect(by('coal')).toBe(7);
  });
  it('29 tile defs: 4 cotton + 8 manufacturer + 5 pottery + 4 coal + 4 iron + 4 brewery', () => {
    expect(TILES).toHaveLength(29);
  });
  it('manufacturer level 4 costs £8+1iron (official player mat, 2026-08-26 复核)', () => {
    const m4 = TILES.find((t) => t.industry === 'manufacturer' && t.level === 4)!;
    expect(m4.costMoney).toBe(8);
    expect(m4.costIron).toBe(1);
  });
  it('pottery 1 and 3 are not developable (lightbulb)', () => {
    expect(TILES.find((t) => t.industry === 'pottery' && t.level === 1)!.developable).toBe(false);
    expect(TILES.find((t) => t.industry === 'pottery' && t.level === 3)!.developable).toBe(false);
  });
  it('level-1 tiles of cotton/manufacturer/coal/iron/brewery are not rail-era buildable; pottery 1 IS', () => {
    for (const t of TILES.filter((x) => x.level === 1)) {
      expect(t.railEraBuildable).toBe(t.industry === 'pottery');
    }
  });
  it('manufacturer 3 and 7 need no beer to sell', () => {
    expect(TILES.find((t) => t.industry === 'manufacturer' && t.level === 3)!.beerToFlip).toBe(0);
    expect(TILES.find((t) => t.industry === 'manufacturer' && t.level === 7)!.beerToFlip).toBe(0);
  });
  it('pottery 5 and brewery 4 are rail-era only', () => {
    const railOnly = TILES.filter((t) => t.railEraOnly);
    expect(railOnly).toHaveLength(2);
    for (const t of railOnly) {
      expect(['pottery', 'brewery']).toContain(t.industry);
      expect(t.railEraBuildable).toBe(true);
    }
  });
  it('flipsBy/sellable: cotton/manufacturer/pottery sell; coal/iron/brewery resource-exhaustion', () => {
    for (const t of TILES) {
      const sellType = ['cotton', 'manufacturer', 'pottery'].includes(t.industry);
      expect(t.flipsBy).toBe(sellType ? 'sell' : 'resource-exhaustion');
      expect(t.sellable).toBe(sellType);
    }
  });
  it('spot-checks full transcription rows', () => {
    const at = (i: string, l: number) => TILES.find((t) => t.industry === i && t.level === l)!;
    // §2.1 cotton 3: £16+1煤+1铁, VP9, +3, 1 link
    expect(at('cotton', 3)).toMatchObject({ count: 3, costMoney: 16, costCoal: 1, costIron: 1, beerToFlip: 1, vp: 9, incomeAdvance: 3, linkIcons: 1 });
    // §2.2 manufacturer 8: £20+2铁, VP11, +1
    expect(at('manufacturer', 8)).toMatchObject({ count: 2, costMoney: 20, costIron: 2, vp: 11, incomeAdvance: 1 });
    // §2.3 pottery 2/4 cost £0+1煤, VP1, +1
    for (const l of [2, 4]) {
      expect(at('pottery', l)).toMatchObject({ costMoney: 0, costCoal: 1, vp: 1, incomeAdvance: 1 });
    }
    // §2.4 coal places 2/3/4/5 cubes
    expect([1, 2, 3, 4].map((l) => at('coal', l).resourcesPlaced)).toEqual([2, 3, 4, 5]);
    // §2.5 iron places 4/4/5/6 cubes, all cost 1 coal
    expect([1, 2, 3, 4].map((l) => at('iron', l).resourcesPlaced)).toEqual([4, 4, 5, 6]);
    expect([1, 2, 3, 4].map((l) => at('iron', l).costCoal)).toEqual([1, 1, 1, 1]);
    // §2.6 brewery: all cost 1 iron, barrels come from BREWERY_BARRELS (era-based, not level)
    expect([1, 2, 3, 4].map((l) => at('brewery', l).costIron)).toEqual([1, 1, 1, 1]);
    expect(at('brewery', 4).vp).toBe(10);
  });
});
