import { describe, expect, it } from 'vitest';
import { LOCATIONS, MERCHANTS } from '@brass/engine';
import { BOARD_HEIGHT, BOARD_WIDTH, LAYOUT } from './layout';

describe('LAYOUT 棋盘坐标', () => {
  it('覆盖全部 LOCATIONS 与 MERCHANTS key（22 地点 + 5 商人位）', () => {
    for (const id of Object.keys(LOCATIONS)) {
      expect(LAYOUT[id], `缺少地点坐标: ${id}`).toBeDefined();
    }
    for (const id of Object.keys(MERCHANTS)) {
      expect(LAYOUT[id], `缺少商人位坐标: ${id}`).toBeDefined();
    }
    expect(Object.keys(LAYOUT)).toHaveLength(
      Object.keys(LOCATIONS).length + Object.keys(MERCHANTS).length,
    );
    expect(Object.keys(LAYOUT)).toHaveLength(27);
  });

  it(`坐标均在 ${BOARD_WIDTH}×${BOARD_HEIGHT} 画布内`, () => {
    expect(BOARD_WIDTH).toBe(1000);
    expect(BOARD_HEIGHT).toBe(760);
    for (const [id, p] of Object.entries(LAYOUT)) {
      expect(p.x, `${id}.x 越界`).toBeGreaterThanOrEqual(0);
      expect(p.x, `${id}.x 越界`).toBeLessThanOrEqual(BOARD_WIDTH);
      expect(p.y, `${id}.y 越界`).toBeGreaterThanOrEqual(0);
      expect(p.y, `${id}.y 越界`).toBeLessThanOrEqual(BOARD_HEIGHT);
    }
  });

  it('任意两点距离 ≥ 30px（圆点与标签不重叠）', () => {
    const entries = Object.entries(LAYOUT);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [idA, a] = entries[i]!;
        const [idB, b] = entries[j]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        expect(d, `${idA} 与 ${idB} 距离 ${d.toFixed(1)}px < 30px`).toBeGreaterThanOrEqual(30);
      }
    }
  });
});
