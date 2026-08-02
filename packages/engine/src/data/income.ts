/**
 * 收入轨（Progress Track，0–99 格，与 VP 轨共用一环）。
 * 逐行转录自 docs/rules-reference.md §4：
 * - 格 0–10 = 等级 −10…0（每级 1 格）
 * - 格 11–30 = 等级 +1…+10（每级 2 格）
 * - 格 31–60 = 等级 +11…+20（每级 3 格）
 * - 格 61–96 = 等级 +21…+29（每级 4 格）
 * - 格 97–99 = 等级 +30
 * 收入增加按格前进；等级 = 当前格旁硬币数字。上限等级 30，贷款下限等级 −10。
 */

export const INCOME_TRACK_MIN_SPACE = 0;
export const INCOME_TRACK_MAX_SPACE = 99;
export const INCOME_LEVEL_MIN = -10;
export const INCOME_LEVEL_MAX = 30;
/** 起始位置：格 10 = 等级 0。 */
export const INCOME_START_SPACE = 10;

/** 某收入等级占据的格区间 [startSpace, endSpace]（闭区间）。level 须在 −10..30。 */
export function INCOME_LEVEL_SPACES(level: number): [startSpace: number, endSpace: number] {
  if (level < INCOME_LEVEL_MIN || level > INCOME_LEVEL_MAX) {
    throw new RangeError(`income level out of range: ${level}`);
  }
  if (level <= 0) {
    const s = level + 10; // 每级 1 格
    return [s, s];
  }
  if (level <= 10) {
    const s = 11 + (level - 1) * 2; // 每级 2 格
    return [s, s + 1];
  }
  if (level <= 20) {
    const s = 31 + (level - 11) * 3; // 每级 3 格
    return [s, s + 2];
  }
  if (level <= 29) {
    const s = 61 + (level - 21) * 4; // 每级 4 格
    return [s, s + 3];
  }
  return [97, 99];
}

/** 当前格对应的收入等级。space 须在 0..99。 */
export function incomeLevelAt(space: number): number {
  if (space < INCOME_TRACK_MIN_SPACE || space > INCOME_TRACK_MAX_SPACE) {
    throw new RangeError(`income space out of range: ${space}`);
  }
  if (space <= 10) return space - 10;
  if (space <= 30) return 1 + Math.floor((space - 11) / 2);
  if (space <= 60) return 11 + Math.floor((space - 31) / 3);
  if (space <= 96) return 21 + Math.floor((space - 61) / 4);
  return 30;
}

/** 收入按格前进，上限格 99（等级 30）。 */
export function advanceIncomeSpace(space: number, n: number): number {
  return Math.min(INCOME_TRACK_MAX_SPACE, space + n);
}

/**
 * 贷款：收入标记后退 3 个**等级**（不是格），落在新等级的最高格。
 * 下限等级 −10（格 0）。
 */
export function loanBacktrack(space: number): number {
  const newLevel = Math.max(INCOME_LEVEL_MIN, incomeLevelAt(space) - 3);
  return INCOME_LEVEL_SPACES(newLevel)[1];
}
