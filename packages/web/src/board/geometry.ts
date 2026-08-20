/**
 * 棋盘几何数据（官方版图扫描像素坐标系，6144×6144）。
 *
 * 来源：官方版图扫描（ikegami/tts_brass，见 scripts/asset-manifest.json）人工标定；
 * 槽位中心逐城目视直读并与引擎槽位序（`LOCATIONS[id].slots` 官方从左到右序）按印刷产业图标对齐
 * （2026-08-20 全量复核：首版 TTS 仿射投影在局部区域误差达 100-280px，已逐城直读修正）；
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
    { x: 3902, y: 1450 },
    { x: 4130, y: 1450 },
    { x: 4340, y: 1450 },
  ],
  derby: [
    { x: 4087, y: 1920 },
    { x: 3865, y: 2115 },
    { x: 4085, y: 2110 },
  ],
  leek: [
    { x: 3197, y: 1362 },
    { x: 3392, y: 1362 },
  ],
  'stoke-on-trent': [
    { x: 2640, y: 1328 },
    { x: 2390, y: 1534 },
    { x: 2596, y: 1534 },
  ],
  stone: [
    { x: 2202, y: 2087 },
    { x: 2382, y: 2087 },
  ],
  uttoxeter: [
    { x: 3270, y: 2030 },
    { x: 3470, y: 2030 },
  ],
  stafford: [
    { x: 2575, y: 2455 },
    { x: 2760, y: 2455 },
  ],
  'burton-on-trent': [
    { x: 3702, y: 2540 },
    { x: 3955, y: 2540 },
  ],
  cannock: [
    { x: 2920, y: 2912 },
    { x: 3080, y: 2912 },
  ],
  tamworth: [
    { x: 3775, y: 3065 },
    { x: 4025, y: 3065 },
  ],
  walsall: [
    { x: 3115, y: 3345 },
    { x: 3330, y: 3345 },
  ],
  wolverhampton: [
    { x: 2455, y: 3220 },
    { x: 2602, y: 3220 },
  ],
  coalbrookdale: [
    { x: 2007, y: 3225 },
    { x: 1902, y: 3425 },
    { x: 2112, y: 3425 },
  ],
  dudley: [
    { x: 2678, y: 3774 },
    { x: 2879, y: 3774 },
  ],
  kidderminster: [
    { x: 2212, y: 4132 },
    { x: 2447, y: 4132 },
  ],
  worcester: [
    { x: 2382, y: 4625 },
    { x: 2587, y: 4625 },
  ],
  birmingham: [
    { x: 3529, y: 3672 },
    { x: 3707, y: 3672 },
    { x: 3537, y: 3862 },
    { x: 3702, y: 3862 },
  ],
  coventry: [
    { x: 4290, y: 3810 },
    { x: 4125, y: 4005 },
    { x: 4365, y: 4005 },
  ],
  nuneaton: [
    { x: 4037, y: 3467 },
    { x: 4262, y: 3467 },
  ],
  redditch: [
    { x: 3306, y: 4320 },
    { x: 3485, y: 4320 },
  ],
  'farm-north': [{ x: 2225, y: 2825 }],
  'farm-south': [{ x: 2100, y: 4425 }],
};

export interface SlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 各地点产业槽位印刷框的内框矩形，顺序与 `LOCATIONS[id].slots` 一致（6144 坐标系）。
 * 标定方法：sharp 行/列亮度 profile 检测印刷白框亮线峰值，成对峰值取内沿；
 * 全部 49 框经叠加目检逐框复核（含单/双图标槽与两个农场酿酒厂槽），框边精度 ±4px。
 * 注意：部分城市印刷框实际位置与 SLOT_CENTERS 有 30-160px 偏差，
 * token 渲染应使用本表而非中心点推算。
 */
export const SLOT_RECTS: Record<LocationId, SlotRect[]> = {
  belper: [
    { x: 3810, y: 1335, w: 185, h: 177 },
    { x: 3998, y: 1335, w: 183, h: 177 },
    { x: 4184, y: 1335, w: 176, h: 177 },
  ],
  derby: [
    { x: 4031, y: 1825, w: 177, h: 185 },
    { x: 3939, y: 2013, w: 176, h: 177 },
    { x: 4119, y: 2013, w: 182, h: 177 },
  ],
  leek: [
    { x: 3105, y: 1277, w: 185, h: 177 },
    { x: 3293, y: 1277, w: 176, h: 177 },
  ],
  'stoke-on-trent': [
    { x: 2636, y: 1381, w: 177, h: 177 },
    { x: 2541, y: 1567, w: 176, h: 176 },
    { x: 2730, y: 1567, w: 176, h: 176 },
  ],
  stone: [
    { x: 2124, y: 1990, w: 176, h: 177 },
    { x: 2304, y: 1990, w: 182, h: 176 },
  ],
  uttoxeter: [
    { x: 3154, y: 1921, w: 186, h: 177 },
    { x: 3343, y: 1921, w: 177, h: 177 },
  ],
  stafford: [
    { x: 2497, y: 2365, w: 177, h: 177 },
    { x: 2677, y: 2365, w: 183, h: 177 },
  ],
  'burton-on-trent': [
    { x: 3627, y: 2481, w: 176, h: 177 },
    { x: 3807, y: 2481, w: 183, h: 177 },
  ],
  cannock: [
    { x: 2793, y: 2774, w: 176, h: 178 },
    { x: 2978, y: 2774, w: 176, h: 177 },
  ],
  tamworth: [
    { x: 3687, y: 2983, w: 177, h: 176 },
    { x: 3869, y: 2983, w: 176, h: 176 },
  ],
  walsall: [
    { x: 3018, y: 3235, w: 177, h: 176 },
    { x: 3204, y: 3235, w: 176, h: 176 },
  ],
  wolverhampton: [
    { x: 2373, y: 3142, w: 176, h: 177 },
    { x: 2558, y: 3143, w: 176, h: 176 },
  ],
  coalbrookdale: [
    { x: 1915, y: 3131, w: 176, h: 184 },
    { x: 1821, y: 3319, w: 177, h: 176 },
    { x: 2007, y: 3317, w: 177, h: 177 },
  ],
  dudley: [
    { x: 2559, y: 3634, w: 176, h: 176 },
    { x: 2744, y: 3633, w: 176, h: 177 },
  ],
  kidderminster: [
    { x: 2280, y: 4047, w: 176, h: 178 },
    { x: 2465, y: 4047, w: 176, h: 178 },
  ],
  worcester: [
    { x: 2332, y: 4566, w: 177, h: 177 },
    { x: 2513, y: 4566, w: 182, h: 177 },
  ],
  birmingham: [
    { x: 3409, y: 3600, w: 176, h: 177 },
    { x: 3596, y: 3600, w: 176, h: 177 },
    { x: 3409, y: 3779, w: 177, h: 186 },
    { x: 3596, y: 3779, w: 176, h: 186 },
  ],
  coventry: [
    { x: 4232, y: 3727, w: 176, h: 176 },
    { x: 4139, y: 3914, w: 176, h: 177 },
    { x: 4319, y: 3914, w: 183, h: 177 },
  ],
  nuneaton: [
    { x: 4047, y: 3387, w: 177, h: 177 },
    { x: 4228, y: 3386, w: 183, h: 177 },
  ],
  redditch: [
    { x: 3222, y: 4261, w: 177, h: 177 },
    { x: 3402, y: 4261, w: 185, h: 177 },
  ],
  'farm-north': [{ x: 2180, y: 2724, w: 176, h: 177 }],
  'farm-south': [{ x: 2023, y: 4346, w: 177, h: 177 }],
};

/**
 * 城市中文铭牌锚点（铭牌中心，6144 坐标系）。
 * 默认：槽位簇质心正下方（最深槽位底边 + 130）——英文印刷横幅之下，不遮英文名；
 * 遮路/无横幅的城逐城侧置或偏移（CITY_LABEL_OVERRIDES，叠加图逐城目视校订）。
 */
const CITY_LABEL_OVERRIDES: Partial<Record<LocationId, Point>> = {
  // 两个农场酿酒厂无英文横幅 → 铭牌放槽位正下方
  'farm-north': { x: 2268, y: 2956 },
  'farm-south': { x: 2010, y: 4578 },
  // 伯顿默认位左缘蹭 Burton–Tamworth 纵向轨道 → 右移 60
  'burton-on-trent': { x: 3807 + 60, y: 2658 + 130 },
  // 雷迪奇/考文垂/纳尼顿：默认位偏低 → 上移 35
  redditch: { x: 3402, y: 4533 },
  coventry: { x: 4319, y: 4186 },
  nuneaton: { x: 4228, y: 3658 },
};

export const CITY_LABEL: Record<LocationId, Point> = Object.fromEntries(
  Object.entries(SLOT_RECTS).map(([id, rects]) => {
    const cx = rects.reduce((s, r) => s + r.x + r.w / 2, 0) / rects.length;
    const bottom = Math.max(...rects.map((r) => r.y + r.h));
    const fallback = { x: Math.round(cx), y: Math.round(bottom + 130) };
    return [id, CITY_LABEL_OVERRIDES[id as LocationId] ?? fallback];
  }),
) as Record<LocationId, Point>;

/**
 * 顺位轨（6144 坐标系）：版图左侧 1-4 号顺位桶位。
 * 玩家头像嵌入**左侧大桶**（TURN_BARRELS,turnOrder[i] → 第 i 名）;
 * 本轮花费的钱币堆(1/5/15 面额)+ £n 数字放在**右侧数字桶上的椭圆块**(TURN_MONEY)。
 */
export const TURN_BARRELS: Point[] = [
  { x: 1490, y: 3780 },
  { x: 1495, y: 4110 },
  { x: 1490, y: 4425 },
  { x: 1495, y: 4700 },
];
export const TURN_MONEY: Point[] = [
  { x: 1770, y: 3785 },
  { x: 1775, y: 4115 },
  { x: 1775, y: 4430 },
  { x: 1772, y: 4705 },
];

/** 商人位几何：板块格与啤酒桶格均为印刷框内沿矩形（6144 坐标系）。 */
export interface MerchantGeom {
  tiles: SlotRect[];
  beer: SlotRect[];
}

/**
 * 商人位矩形（2026-08-21 标定，替换原手估中心点——原值偏差达 60-280px）。
 * 标定方法：2x 放大 + 10px 坐标网格裁片目视初读，条带亮度 profile 定位银色框线，
 * 再两轮醒目色框叠加目检逐框微调；框边精度 ±4px。
 * tiles 顺序 = 引擎 `merchants[id].tiles` 从左到右序；beer[i] 对应 tiles[i] 旁的啤酒桶格
 * （2 格商人位：啤酒格外侧对齐——左格左对齐、右格右对齐，奖励框居中；Warrington/Nottingham
 * 啤酒格在板块格下方，Gloucester/Oxford 在上方，Shrewsbury 在右侧）。
 * 板块格为 D 形印刷框（直边+浅弧底），矩形取其内沿包围盒（h 含弧底下沉 ~10px）。
 */
export const MERCHANT_GEOM: Record<MerchantId, MerchantGeom> = {
  warrington: {
    tiles: [
      { x: 2004, y: 1496, w: 171, h: 166 },
      { x: 2186, y: 1496, w: 180, h: 166 },
    ],
    beer: [
      { x: 2011, y: 1682, w: 90, h: 98 },
      { x: 2236, y: 1682, w: 93, h: 98 },
    ],
  },
  nottingham: {
    tiles: [
      { x: 4505, y: 1749, w: 177, h: 178 },
      { x: 4702, y: 1749, w: 167, h: 178 },
    ],
    beer: [
      { x: 4514, y: 1958, w: 92, h: 102 },
      { x: 4781, y: 1958, w: 88, h: 102 },
    ],
  },
  shrewsbury: {
    tiles: [{ x: 1343, y: 3311, w: 178, h: 186 }],
    beer: [{ x: 1551, y: 3329, w: 95, h: 100 }],
  },
  gloucester: {
    tiles: [
      { x: 3313, y: 4706, w: 178, h: 180 },
      { x: 3500, y: 4706, w: 170, h: 180 },
    ],
    beer: [
      { x: 3313, y: 4595, w: 89, h: 93 },
      { x: 3582, y: 4595, w: 92, h: 93 },
    ],
  },
  oxford: {
    tiles: [
      { x: 4203, y: 4402, w: 176, h: 182 },
      { x: 4390, y: 4402, w: 170, h: 182 },
    ],
    beer: [
      { x: 4204, y: 4291, w: 86, h: 98 },
      { x: 4470, y: 4291, w: 85, h: 98 },
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
  0: { x: 4120, y: 1725 }, // belper-derby
  1: { x: 3645, y: 1360 }, // belper-leek
  2: { x: 3798, y: 3932 }, // birmingham-coventry
  3: { x: 3000, y: 3730 }, // birmingham-dudley
  4: { x: 3840, y: 3615 }, // birmingham-nuneaton
  5: { x: 3885, y: 4165 }, // birmingham-oxford
  6: { x: 3520, y: 4140 }, // birmingham-redditch
  7: { x: 3790, y: 3420 }, // birmingham-tamworth
  8: { x: 3320, y: 3625 }, // birmingham-walsall
  9: { x: 2935, y: 4320 }, // birmingham-worcester
  10: { x: 3315, y: 2645 }, // burton-on-trent-cannock
  11: { x: 4095, y: 2300 }, // burton-on-trent-derby
  12: { x: 3015, y: 2200 }, // burton-on-trent-stone
  13: { x: 3845, y: 2740 }, // burton-on-trent-tamworth
  14: { x: 3415, y: 2920 }, // burton-on-trent-walsall
  15: { x: 2890, y: 2570 }, // cannock-stafford
  16: { x: 2462, y: 2801 }, // cannock-farm-north
  17: { x: 3170, y: 3045 }, // cannock-walsall
  18: { x: 2514, y: 3024 }, // cannock-wolverhampton
  19: { x: 2130, y: 3825 }, // coalbrookdale-kidderminster
  20: { x: 1685, y: 3250 }, // coalbrookdale-shrewsbury
  21: { x: 2102, y: 3284 }, // coalbrookdale-wolverhampton
  22: { x: 4460, y: 3615 }, // coventry-nuneaton
  23: { x: 4430, y: 1910 }, // derby-nottingham
  24: { x: 3670, y: 2050 }, // derby-uttoxeter
  25: { x: 2340, y: 3984 }, // dudley-kidderminster
  26: { x: 2600, y: 3580 }, // dudley-wolverhampton
  27: { x: 3040, y: 4640 }, // gloucester-redditch
  28: { x: 2800, y: 4765 }, // gloucester-worcester
  29: { x: 2460, y: 4445 }, // kidderminster-worcester（含 farm-south 分支；贴印刷走廊与农场岔道交汇点）
  30: { x: 2895, y: 1415 }, // leek-stoke-on-trent
  31: { x: 4095, y: 3048 }, // nuneaton-tamworth
  32: { x: 3566, y: 4427 }, // redditch-oxford
  33: { x: 2280, y: 2390 }, // stafford-stone
  34: { x: 2445, y: 1842 }, // stoke-on-trent-stone
  35: { x: 2405, y: 1410 }, // stoke-on-trent-warrington
  36: { x: 2720, y: 2015 }, // stone-uttoxeter
  37: { x: 3565, y: 3245 }, // tamworth-walsall
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
  const rects = MERCHANT_GEOM[id].tiles;
  const cx = rects.reduce((s, r) => s + r.x + r.w / 2, 0) / rects.length;
  const cy = rects.reduce((s, r) => s + r.y + r.h / 2, 0) / rects.length;
  return { x: Math.round(cx), y: Math.round(cy) };
}
