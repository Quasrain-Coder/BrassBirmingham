/**
 * 产业板块数值表（每名玩家 45 块，29 个 TileDef）。
 * 逐行转录自 docs/rules-reference.md §2.1–2.6（[M] 玩家面板美术 + [T][N] 三方核对）。
 *
 * 注意：
 * - 制造 IV 成本采用官方 £14 + 1 铁（TTS/npow 误作 £8，见 rules-reference §10）。
 * - 酿酒厂建成放桶数按时代而非等级，见 market.ts 的 BREWERY_BARRELS；
 *   此处 brewery 的 resourcesPlaced 恒为 0（啤酒桶不是煤/铁方块）。
 * - beerToFlip 仅对 sellable 产业有意义（印在板块右上角）；煤/铁/酿翻面不靠啤酒，恒为 0。
 */
import type { IndustryType } from '../types.js';

export interface TileDef {
  industry: IndustryType;
  level: number;
  /** 该级板块数量（每名玩家）。 */
  count: number;
  costMoney: number;
  costCoal: number;
  costIron: number;
  /** Sell 翻面需消耗的啤酒桶数（板块右上）。 */
  beerToFlip: number;
  /** 建成时放置的煤/铁方块数（仅煤/铁厂非零）。 */
  resourcesPlaced: number;
  /** 翻面后时代末得分（板块左下）。 */
  vp: number;
  /** 翻面时收入轨前进格数（板块右下）。 */
  incomeAdvance: number;
  /** 翻面板块上的连接图标数（Link 计分用）。 */
  linkIcons: number;
  /** 铁路时代是否可建（level≥2 全 true；level 1 仅 pottery 例外）。 */
  railEraBuildable: boolean;
  /** 仅铁路时代可建（pottery 5 / brewery 4）。 */
  railEraOnly: boolean;
  /** 可被 Develop 移除（灯泡陶 I/III 不可）。 */
  developable: boolean;
  /** 可通过 Sell 翻面（棉/制造/陶）。 */
  sellable: boolean;
  flipsBy: 'sell' | 'resource-exhaustion';
}

const SELL_INDUSTRIES: ReadonlySet<IndustryType> = new Set(['cotton', 'manufacturer', 'pottery']);

interface TileRow {
  industry: IndustryType;
  level: number;
  count: number;
  costMoney: number;
  costCoal?: number;
  costIron?: number;
  beerToFlip?: number;
  resourcesPlaced?: number;
  vp: number;
  incomeAdvance: number;
  linkIcons: number;
  railEraBuildable?: boolean;
  railEraOnly?: boolean;
  developable?: boolean;
}

const tile = (r: TileRow): TileDef => ({
  industry: r.industry,
  level: r.level,
  count: r.count,
  costMoney: r.costMoney,
  costCoal: r.costCoal ?? 0,
  costIron: r.costIron ?? 0,
  beerToFlip: r.beerToFlip ?? 0,
  resourcesPlaced: r.resourcesPlaced ?? 0,
  vp: r.vp,
  incomeAdvance: r.incomeAdvance,
  linkIcons: r.linkIcons,
  railEraBuildable: r.railEraBuildable ?? true,
  railEraOnly: r.railEraOnly ?? false,
  developable: r.developable ?? true,
  sellable: SELL_INDUSTRIES.has(r.industry),
  flipsBy: SELL_INDUSTRIES.has(r.industry) ? 'sell' : 'resource-exhaustion',
});

// §2.1 Cotton Mill（翻面方式：Sell）
// §2.2 Manufacturer（翻面方式：Sell）
// §2.3 Pottery（翻面方式：Sell；I/III 灯泡不可 Develop；V 仅铁路时代）
// §2.4 Coal Mine（翻面方式：煤耗尽）
// §2.5 Iron Works（翻面方式：铁耗尽）
// §2.6 Brewery（翻面方式：啤酒耗尽；IV 仅铁路时代）
const rows: TileRow[] = [
  // §2.1 棉纺厂
  { industry: 'cotton', level: 1, count: 3, costMoney: 12, beerToFlip: 1, vp: 5, incomeAdvance: 5, linkIcons: 1, railEraBuildable: false },
  { industry: 'cotton', level: 2, count: 2, costMoney: 14, costCoal: 1, beerToFlip: 1, vp: 5, incomeAdvance: 4, linkIcons: 2 },
  { industry: 'cotton', level: 3, count: 3, costMoney: 16, costCoal: 1, costIron: 1, beerToFlip: 1, vp: 9, incomeAdvance: 3, linkIcons: 1 },
  { industry: 'cotton', level: 4, count: 3, costMoney: 18, costCoal: 1, costIron: 1, beerToFlip: 1, vp: 12, incomeAdvance: 2, linkIcons: 1 },
  // §2.2 制造厂
  { industry: 'manufacturer', level: 1, count: 1, costMoney: 8, costCoal: 1, beerToFlip: 1, vp: 3, incomeAdvance: 5, linkIcons: 2, railEraBuildable: false },
  { industry: 'manufacturer', level: 2, count: 2, costMoney: 10, costIron: 1, beerToFlip: 1, vp: 5, incomeAdvance: 1, linkIcons: 1 },
  { industry: 'manufacturer', level: 3, count: 1, costMoney: 12, costCoal: 2, beerToFlip: 0, vp: 4, incomeAdvance: 4, linkIcons: 0 },
  { industry: 'manufacturer', level: 4, count: 1, costMoney: 14, costIron: 1, beerToFlip: 1, vp: 3, incomeAdvance: 6, linkIcons: 1 },
  { industry: 'manufacturer', level: 5, count: 2, costMoney: 16, costCoal: 1, beerToFlip: 2, vp: 8, incomeAdvance: 2, linkIcons: 2 },
  { industry: 'manufacturer', level: 6, count: 1, costMoney: 20, beerToFlip: 1, vp: 7, incomeAdvance: 6, linkIcons: 1 },
  { industry: 'manufacturer', level: 7, count: 1, costMoney: 16, costCoal: 1, costIron: 1, beerToFlip: 0, vp: 9, incomeAdvance: 4, linkIcons: 0 },
  { industry: 'manufacturer', level: 8, count: 2, costMoney: 20, costIron: 2, beerToFlip: 1, vp: 11, incomeAdvance: 1, linkIcons: 1 },
  // §2.3 陶瓷厂
  { industry: 'pottery', level: 1, count: 1, costMoney: 17, costIron: 1, beerToFlip: 1, vp: 10, incomeAdvance: 5, linkIcons: 1, developable: false },
  { industry: 'pottery', level: 2, count: 1, costMoney: 0, costCoal: 1, beerToFlip: 1, vp: 1, incomeAdvance: 1, linkIcons: 1 },
  { industry: 'pottery', level: 3, count: 1, costMoney: 22, costCoal: 2, beerToFlip: 2, vp: 11, incomeAdvance: 5, linkIcons: 1, developable: false },
  { industry: 'pottery', level: 4, count: 1, costMoney: 0, costCoal: 1, beerToFlip: 1, vp: 1, incomeAdvance: 1, linkIcons: 1 },
  { industry: 'pottery', level: 5, count: 1, costMoney: 24, costCoal: 2, beerToFlip: 2, vp: 20, incomeAdvance: 5, linkIcons: 1, railEraOnly: true },
  // §2.4 煤矿
  { industry: 'coal', level: 1, count: 1, costMoney: 5, resourcesPlaced: 2, vp: 1, incomeAdvance: 4, linkIcons: 2, railEraBuildable: false },
  { industry: 'coal', level: 2, count: 2, costMoney: 7, resourcesPlaced: 3, vp: 2, incomeAdvance: 7, linkIcons: 1 },
  { industry: 'coal', level: 3, count: 2, costMoney: 8, costIron: 1, resourcesPlaced: 4, vp: 3, incomeAdvance: 6, linkIcons: 1 },
  { industry: 'coal', level: 4, count: 2, costMoney: 10, costIron: 1, resourcesPlaced: 5, vp: 4, incomeAdvance: 5, linkIcons: 1 },
  // §2.5 铁厂
  { industry: 'iron', level: 1, count: 1, costMoney: 5, costCoal: 1, resourcesPlaced: 4, vp: 3, incomeAdvance: 3, linkIcons: 1, railEraBuildable: false },
  { industry: 'iron', level: 2, count: 1, costMoney: 7, costCoal: 1, resourcesPlaced: 4, vp: 5, incomeAdvance: 3, linkIcons: 1 },
  { industry: 'iron', level: 3, count: 1, costMoney: 9, costCoal: 1, resourcesPlaced: 5, vp: 7, incomeAdvance: 2, linkIcons: 1 },
  { industry: 'iron', level: 4, count: 1, costMoney: 12, costCoal: 1, resourcesPlaced: 6, vp: 9, incomeAdvance: 1, linkIcons: 1 },
  // §2.6 酿酒厂（放桶数按时代，见 market.ts BREWERY_BARRELS）
  { industry: 'brewery', level: 1, count: 2, costMoney: 5, costIron: 1, vp: 4, incomeAdvance: 4, linkIcons: 2, railEraBuildable: false },
  { industry: 'brewery', level: 2, count: 2, costMoney: 7, costIron: 1, vp: 5, incomeAdvance: 5, linkIcons: 2 },
  { industry: 'brewery', level: 3, count: 2, costMoney: 9, costIron: 1, vp: 7, incomeAdvance: 5, linkIcons: 2 },
  { industry: 'brewery', level: 4, count: 1, costMoney: 9, costIron: 1, vp: 10, incomeAdvance: 5, linkIcons: 2, railEraOnly: true },
];

export const TILES: TileDef[] = rows.map(tile);

/** 查某产业某等级的板块定义。 */
export function tileDef(industry: IndustryType, level: number): TileDef | undefined {
  return TILES.find((t) => t.industry === industry && t.level === level);
}
