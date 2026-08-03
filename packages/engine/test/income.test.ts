import { describe, it, expect } from 'vitest';
import { INCOME_LEVEL_SPACES, incomeLevelAt, advanceIncomeSpace, loanBacktrack } from '../src/data/income.js';

describe('income track (rules-reference §4)', () => {
  it('level bands', () => {
    expect(incomeLevelAt(0)).toBe(-10);
    expect(incomeLevelAt(10)).toBe(0);   // 起始位置
    expect(incomeLevelAt(11)).toBe(1);
    expect(incomeLevelAt(30)).toBe(10);
    expect(incomeLevelAt(31)).toBe(11);
    expect(incomeLevelAt(99)).toBe(30);
  });
  it('every level maps to its documented space band', () => {
    // 0–10: −10…0（每级 1 格）
    expect(INCOME_LEVEL_SPACES(-10)).toEqual([0, 0]);
    expect(INCOME_LEVEL_SPACES(0)).toEqual([10, 10]);
    // 11–30: +1…+10（每级 2 格）
    expect(INCOME_LEVEL_SPACES(1)).toEqual([11, 12]);
    expect(INCOME_LEVEL_SPACES(10)).toEqual([29, 30]);
    // 31–60: +11…+20（每级 3 格）
    expect(INCOME_LEVEL_SPACES(11)).toEqual([31, 33]);
    expect(INCOME_LEVEL_SPACES(20)).toEqual([58, 60]);
    // 61–96: +21…+29（每级 4 格）
    expect(INCOME_LEVEL_SPACES(21)).toEqual([61, 64]);
    expect(INCOME_LEVEL_SPACES(29)).toEqual([93, 96]);
    // 97–99: +30
    expect(INCOME_LEVEL_SPACES(30)).toEqual([97, 99]);
    // round-trip: every space in a band reports that level
    for (let level = -10; level <= 30; level++) {
      const [start, end] = INCOME_LEVEL_SPACES(level);
      for (let s = start; s <= end; s++) {
        expect(incomeLevelAt(s)).toBe(level);
      }
    }
  });
  it('advance caps at level 30', () => {
    expect(advanceIncomeSpace(95, 100)).toBe(99);
  });
  it('advance moves by spaces', () => {
    expect(advanceIncomeSpace(10, 5)).toBe(15);
    expect(advanceIncomeSpace(0, 3)).toBe(3);
  });
  it('loan backtracks 3 LEVELS and lands on highest space of the new level', () => {
    // space 10 = level 0；退 3 级 = level -3 = space 7
    expect(loanBacktrack(10)).toBe(7);
    // level 1 占 space 11-12；从 space 12(level 1) 退 3 级到 level -2 = space 8
    expect(loanBacktrack(12)).toBe(8);
    // 下限 level -10
    expect(loanBacktrack(2)).toBe(0);
  });
  it('loan from high band lands on highest space of new level', () => {
    // space 30 = level 10；退 3 级 = level 7 = spaces 23-24 → 24
    expect(loanBacktrack(30)).toBe(24);
    // space 99 = level 30；退 3 级 = level 27 = spaces 85-88 → 88
    expect(loanBacktrack(99)).toBe(88);
  });
});
