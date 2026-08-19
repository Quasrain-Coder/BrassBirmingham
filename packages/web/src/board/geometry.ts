/**
 * 棋盘几何数据（官方版图扫描像素坐标系，6144×6144）。
 *
 * 来源：官方版图扫描（ikegami/tts_brass，见 scripts/asset-manifest.json）人工标定；
 * 槽位中心逐城目视读取并与引擎槽位序（`LOCATIONS[id].slots` 官方从左到右序）按印刷产业图标对齐；
 * 连线中点由 TTS mod 触发器世界坐标仿射投影得到；煤/铁市场格、商人位、VP/收入环轨
 * 端点目视读取后线性插值。SVG viewBox 用 `0 0 6144 6144`，与显示分辨率无关。
 */
import type { LocationId, MerchantId } from '@brass/engine';

export const BOARD_SIZE = 6144;
/** 产业槽位（印刷白框）边长。 */
export const SLOT_SIZE = 205;
/** 商人板块格宽/高。 */
export const MERCHANT_TILE_W = 200;
export const MERCHANT_TILE_H = 260;

export interface Point {
  x: number;
  y: number;
}

/**
 * 各地点产业槽位中心。数组顺序 = 引擎 `LOCATIONS[id].slots` 顺序
 * （按印刷图标逐一核对；Tamworth/Worcester 两槽图标相同，顺序无影响）。
 */
export const SLOT_CENTERS: Record<LocationId, Point[]> = {
  belper: [
    { x: 3861, y: 1439 },
    { x: 4097, y: 1439 },
    { x: 4333, y: 1439 },
  ],
  derby: [
    { x: 4112, y: 1938 },
    { x: 3910, y: 2138 },
    { x: 4315, y: 2138 },
  ],
  leek: [
    { x: 3143, y: 1341 },
    { x: 3343, y: 1341 },
  ],
  'stoke-on-trent': [
    { x: 2672, y: 1435 },
    { x: 2470, y: 1635 },
    { x: 2875, y: 1635 },
  ],
  stone: [
    { x: 2237, y: 2090 },
    { x: 2440, y: 2090 },
  ],
  uttoxeter: [
    { x: 3228, y: 2026 },
    { x: 3428, y: 2026 },
  ],
  stafford: [
    { x: 2554, y: 2409 },
    { x: 2754, y: 2409 },
  ],
  'burton-on-trent': [
    { x: 3640, y: 2585 },
    { x: 3852, y: 2585 },
  ],
  cannock: [
    { x: 2895, y: 2875 },
    { x: 3100, y: 2875 },
  ],
  tamworth: [
    { x: 3784, y: 3065 },
    { x: 3984, y: 3065 },
  ],
  walsall: [
    { x: 3155, y: 3242 },
    { x: 3355, y: 3242 },
  ],
  wolverhampton: [
    { x: 2410, y: 3200 },
    { x: 2610, y: 3200 },
  ],
  coalbrookdale: [
    { x: 2000, y: 3215 },
    { x: 1905, y: 3420 },
    { x: 2105, y: 3420 },
  ],
  dudley: [
    { x: 2634, y: 3758 },
    { x: 2834, y: 3758 },
  ],
  kidderminster: [
    { x: 2193, y: 4124 },
    { x: 2393, y: 4124 },
  ],
  worcester: [
    { x: 2432, y: 4676 },
    { x: 2632, y: 4676 },
  ],
  birmingham: [
    { x: 3441, y: 3704 },
    { x: 3649, y: 3704 },
    { x: 3441, y: 3912 },
    { x: 3649, y: 3912 },
  ],
  coventry: [
    { x: 4267, y: 3800 },
    { x: 4065, y: 4010 },
    { x: 4267, y: 4010 },
  ],
  nuneaton: [
    { x: 3987, y: 3467 },
    { x: 4190, y: 3467 },
  ],
  redditch: [
    { x: 3285, y: 4370 },
    { x: 3485, y: 4370 },
  ],
  'farm-north': [{ x: 2225, y: 2825 }],
  'farm-south': [{ x: 1945, y: 4725 }],
};

/** 城市中文名标签锚点（印在英文名牌附近；下方偏移，特殊城另调）。 */
export const CITY_LABEL: Record<LocationId, Point> = Object.fromEntries(
  Object.entries(SLOT_CENTERS).map(([id, pts]) => {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = Math.max(...pts.map((p) => p.y));
    return [id, { x: Math.round(cx), y: my + 165 }];
  }),
) as Record<LocationId, Point>;

/** 商人位：板块格（按引擎 `merchants[id].tiles` 顺序）与啤酒桶格。 */
export const MERCHANT_GEOM: Record<MerchantId, { tiles: Point[]; beer: Point[] }> = {
  warrington: {
    tiles: [
      { x: 1925, y: 1610 },
      { x: 2110, y: 1610 },
    ],
    beer: [
      { x: 1900, y: 1765 },
      { x: 2190, y: 1765 },
    ],
  },
  nottingham: {
    tiles: [
      { x: 4590, y: 1520 },
      { x: 4770, y: 1520 },
    ],
    beer: [
      { x: 4560, y: 1700 },
      { x: 4820, y: 1700 },
    ],
  },
  shrewsbury: {
    tiles: [{ x: 1300, y: 3425 }],
    beer: [{ x: 1475, y: 3355 }],
  },
  gloucester: {
    tiles: [
      { x: 3245, y: 4830 },
      { x: 3530, y: 4830 },
    ],
    beer: [
      { x: 3240, y: 4605 },
      { x: 3530, y: 4605 },
    ],
  },
  oxford: {
    tiles: [
      { x: 3980, y: 4500 },
      { x: 4240, y: 4500 },
    ],
    beer: [
      { x: 3860, y: 4270 },
      { x: 4235, y: 4270 },
    ],
  },
};

/**
 * 煤市场 14 格（索引 0 = 最便宜 £1，与引擎 `COAL_MARKET_PRICES` 同序）。
 * 行 y = 3140 − (price−1)×120，行内两格 x = 4455 / 4530。
 */
export const COAL_MARKET_CELLS: Point[] = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7].map(
  (price, i) => ({ x: 4455 + (i % 2) * 75, y: 3140 - (price - 1) * 120 }),
);
/** 铁市场 10 格（索引 0 = £1）。 */
export const IRON_MARKET_CELLS: Point[] = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5].map((price, i) => ({
  x: 4670 + (i % 2) * 80,
  y: 3140 - (price - 1) * 120,
}));
export const MARKET_CELL_SIZE = 66;

/** 环轨一侧：端点间线性插值。 */
interface RingSide {
  from: Point;
  to: Point;
  count: number;
}
/** VP 轨（外环大圆）：0–24 左（下→上）、25–48 顶（左→右）、49–73 右（上→下）、74–99 底（右→左）。 */
const VP_SIDES: RingSide[] = [
  { from: { x: 1100, y: 4740 }, to: { x: 1130, y: 1370 }, count: 25 },
  { from: { x: 1325, y: 1125 }, to: { x: 4840, y: 1110 }, count: 24 },
  { from: { x: 4975, y: 1370 }, to: { x: 4975, y: 4610 }, count: 25 },
  { from: { x: 4620, y: 4985 }, to: { x: 1320, y: 4980 }, count: 26 },
];
/** 收入轨（内环小圆，与 VP 环共用走向）：每侧 25 格。 */
const INCOME_SIDES: RingSide[] = [
  { from: { x: 1175, y: 4740 }, to: { x: 1175, y: 1370 }, count: 25 },
  { from: { x: 1325, y: 1200 }, to: { x: 4992, y: 1200 }, count: 25 },
  { from: { x: 4855, y: 1505 }, to: { x: 4855, y: 4745 }, count: 25 },
  { from: { x: 4620, y: 4935 }, to: { x: 1320, y: 4935 }, count: 25 },
];

function ringPositions(sides: RingSide[]): Point[] {
  const out: Point[] = [];
  for (const { from, to, count } of sides) {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1);
      out.push({ x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t) });
    }
  }
  return out;
}

/** VP 0–99 → 外环圆心。 */
export const VP_TRACK: Point[] = ringPositions(VP_SIDES);
/** 收入格 0–99 → 内环圆心（与引擎收入 space 索引一致）。 */
export const INCOME_TRACK: Point[] = ringPositions(INCOME_SIDES);

/**
 * 39 条连线的路径中点（TTS 触发器仿射投影，键 = 引擎 `LINKS` 0 基下标）。
 * 渲染时按 端点A → 中点 → 端点B 折线沿印刷运河/铁路绘制。
 */
export const LINK_MIDPOINTS: Record<number, Point> = {
  0: { x: 4051, y: 1495 }, // belper-derby
  1: { x: 3577, y: 1163 }, // belper-leek
  2: { x: 3798, y: 3932 }, // birmingham-coventry
  3: { x: 2995, y: 3798 }, // birmingham-dudley
  4: { x: 3782, y: 3618 }, // birmingham-nuneaton
  5: { x: 3803, y: 4130 }, // birmingham-oxford
  6: { x: 3380, y: 4142 }, // birmingham-redditch
  7: { x: 3720, y: 3371 }, // birmingham-tamworth
  8: { x: 3159, y: 3606 }, // birmingham-walsall
  9: { x: 2847, y: 4319 }, // birmingham-worcester
  10: { x: 3258, y: 2578 }, // burton-on-trent-cannock
  11: { x: 4006, y: 2222 }, // burton-on-trent-derby
  12: { x: 3015, y: 2160 }, // burton-on-trent-stone
  13: { x: 3753, y: 2726 }, // burton-on-trent-tamworth
  14: { x: 3307, y: 2908 }, // burton-on-trent-walsall
  15: { x: 2862, y: 2567 }, // cannock-stafford
  16: { x: 2462, y: 2801 }, // cannock-farm-north
  17: { x: 3112, y: 3031 }, // cannock-walsall
  18: { x: 2514, y: 3024 }, // cannock-wolverhampton
  19: { x: 1932, y: 3965 }, // coalbrookdale-kidderminster
  20: { x: 1588, y: 3327 }, // coalbrookdale-shrewsbury
  21: { x: 2102, y: 3284 }, // coalbrookdale-wolverhampton
  22: { x: 4387, y: 3589 }, // coventry-nuneaton
  23: { x: 4273, y: 1678 }, // derby-nottingham
  24: { x: 3649, y: 1932 }, // derby-uttoxeter
  25: { x: 2340, y: 3984 }, // dudley-kidderminster
  26: { x: 2433, y: 3577 }, // dudley-wolverhampton
  27: { x: 2930, y: 4588 }, // gloucester-redditch
  28: { x: 2641, y: 4892 }, // gloucester-worcester
  29: { x: 2271, y: 4549 }, // kidderminster-worcester（含 farm-south 分支）
  30: { x: 2857, y: 1271 }, // leek-stoke-on-trent
  31: { x: 4095, y: 3048 }, // nuneaton-tamworth
  32: { x: 3566, y: 4427 }, // redditch-oxford
  33: { x: 2205, y: 2379 }, // stafford-stone
  34: { x: 2445, y: 1842 }, // stoke-on-trent-stone
  35: { x: 2399, y: 1369 }, // stoke-on-trent-warrington
  36: { x: 2719, y: 1952 }, // stone-uttoxeter
  37: { x: 3448, y: 3220 }, // tamworth-walsall
  38: { x: 2758, y: 3263 }, // walsall-wolverhampton
};

/** 地点锚点（槽位簇质心）：连线端点用。 */
export function locationAnchor(id: LocationId): Point {
  const pts = SLOT_CENTERS[id] ?? [{ x: 0, y: 0 }];
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return { x: Math.round(cx), y: Math.round(cy) };
}

/** 商人位锚点（连线端点用板块格簇质心）。 */
export function merchantAnchor(id: MerchantId): Point {
  const pts = MERCHANT_GEOM[id].tiles;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return { x: Math.round(cx), y: Math.round(cy) };
}
