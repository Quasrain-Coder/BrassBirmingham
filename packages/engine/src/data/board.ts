/**
 * 版图拓扑数据。逐行转录自 docs/rules-reference.md §1.1 / §1.2 / §1.3。
 * 槽位图例：cotton=棉, manufacturer=制造, pottery=陶, coal=煤, iron=铁, brewery=酿。
 */
import type { Era, IndustrySlot, IndustryType, Link, LocationId, MerchantId } from '../types.js';

export type Region = 'derbyshire' | 'staffordshire' | 'midlands' | 'black-country' | 'birmingham' | 'farm';

export interface LocationDef {
  name: string;
  region: Region;
  /** 官方槽位序（从左到右）；建造时优先单图标槽。 */
  slots: IndustrySlot[];
}

export interface MerchantDef {
  slots: number;
  bonus: { type: 'vp' | 'income' | 'money' | 'develop'; amount: number };
  /** 与该商人位相邻的地点（§1.3 连接边列）。 */
  links: LocationId[];
}

const s = (...industries: IndustryType[]): IndustrySlot => ({ industries });

// §1.1：20 个 named locations + 2 个农场酿酒厂。键为 kebab-case id。
const locationData = {
  belper: {
    name: 'Belper',
    region: 'derbyshire',
    slots: [s('cotton', 'manufacturer'), s('coal'), s('pottery')],
  },
  derby: {
    name: 'Derby',
    region: 'derbyshire',
    slots: [s('cotton', 'brewery'), s('cotton', 'manufacturer'), s('iron')],
  },
  leek: {
    name: 'Leek',
    region: 'staffordshire',
    slots: [s('cotton', 'manufacturer'), s('cotton', 'coal')],
  },
  'stoke-on-trent': {
    name: 'Stoke-on-Trent',
    region: 'staffordshire',
    slots: [s('cotton', 'manufacturer'), s('pottery', 'iron'), s('manufacturer')],
  },
  stone: {
    name: 'Stone',
    region: 'staffordshire',
    slots: [s('cotton', 'brewery'), s('manufacturer', 'coal')],
  },
  uttoxeter: {
    name: 'Uttoxeter',
    region: 'staffordshire',
    slots: [s('manufacturer', 'brewery'), s('cotton', 'brewery')],
  },
  stafford: {
    name: 'Stafford',
    region: 'midlands',
    slots: [s('manufacturer', 'brewery'), s('pottery')],
  },
  'burton-on-trent': {
    name: 'Burton-on-Trent',
    region: 'midlands',
    slots: [s('manufacturer', 'coal'), s('brewery')],
  },
  cannock: {
    name: 'Cannock',
    region: 'midlands',
    slots: [s('manufacturer', 'coal'), s('coal')],
  },
  tamworth: {
    name: 'Tamworth',
    region: 'midlands',
    slots: [s('cotton', 'coal'), s('cotton', 'coal')],
  },
  walsall: {
    name: 'Walsall',
    region: 'midlands',
    slots: [s('iron', 'manufacturer'), s('manufacturer', 'brewery')],
  },
  wolverhampton: {
    name: 'Wolverhampton',
    region: 'black-country',
    slots: [s('manufacturer'), s('manufacturer', 'coal')],
  },
  coalbrookdale: {
    name: 'Coalbrookdale',
    region: 'black-country',
    slots: [s('iron', 'brewery'), s('iron'), s('coal')],
  },
  dudley: {
    name: 'Dudley',
    region: 'black-country',
    slots: [s('coal'), s('iron')],
  },
  kidderminster: {
    name: 'Kidderminster',
    region: 'black-country',
    slots: [s('cotton', 'coal'), s('cotton')],
  },
  worcester: {
    name: 'Worcester',
    region: 'black-country',
    slots: [s('cotton'), s('cotton')],
  },
  birmingham: {
    name: 'Birmingham',
    region: 'birmingham',
    slots: [s('cotton', 'manufacturer'), s('manufacturer'), s('iron'), s('manufacturer')],
  },
  coventry: {
    name: 'Coventry',
    region: 'birmingham',
    slots: [s('pottery'), s('manufacturer', 'coal'), s('iron', 'manufacturer')],
  },
  nuneaton: {
    name: 'Nuneaton',
    region: 'birmingham',
    slots: [s('manufacturer', 'brewery'), s('cotton', 'coal')],
  },
  redditch: {
    name: 'Redditch',
    region: 'birmingham',
    slots: [s('manufacturer', 'coal'), s('iron')],
  },
  'farm-north': {
    name: 'Farm Brewery (North)',
    region: 'farm',
    slots: [s('brewery')],
  },
  'farm-south': {
    name: 'Farm Brewery (South)',
    region: 'farm',
    slots: [s('brewery')],
  },
} satisfies Record<string, LocationDef>;

/**
 * 交叉类型说明：与具体字面量类型求交后，已知键（如 LOCATIONS.birmingham）
 * 在 noUncheckedIndexedAccess 下仍返回确定类型；未知字符串索引返回 LocationDef | undefined。
 */
export const LOCATIONS: Record<LocationId, LocationDef> & typeof locationData = locationData;

// §1.2：39 条边，顺序与表内 # 一致（下标 = # - 1）。
export const LINKS: Link[] = [
  { a: 'belper', b: 'derby', canal: true, rail: true }, // 1
  { a: 'belper', b: 'leek', canal: false, rail: true }, // 2
  { a: 'birmingham', b: 'coventry', canal: true, rail: true }, // 3
  { a: 'birmingham', b: 'dudley', canal: true, rail: true }, // 4
  { a: 'birmingham', b: 'nuneaton', canal: false, rail: true }, // 5
  { a: 'birmingham', b: 'oxford', canal: true, rail: true }, // 6
  { a: 'birmingham', b: 'redditch', canal: false, rail: true }, // 7
  { a: 'birmingham', b: 'tamworth', canal: true, rail: true }, // 8
  { a: 'birmingham', b: 'walsall', canal: true, rail: true }, // 9
  { a: 'birmingham', b: 'worcester', canal: true, rail: true }, // 10
  { a: 'burton-on-trent', b: 'cannock', canal: false, rail: true }, // 11
  { a: 'burton-on-trent', b: 'derby', canal: true, rail: true }, // 12
  { a: 'burton-on-trent', b: 'stone', canal: true, rail: true }, // 13
  { a: 'burton-on-trent', b: 'tamworth', canal: true, rail: true }, // 14
  { a: 'burton-on-trent', b: 'walsall', canal: true, rail: false }, // 15
  { a: 'cannock', b: 'stafford', canal: true, rail: true }, // 16
  { a: 'cannock', b: 'farm-north', canal: true, rail: true }, // 17
  { a: 'cannock', b: 'walsall', canal: true, rail: true }, // 18
  { a: 'cannock', b: 'wolverhampton', canal: true, rail: true }, // 19
  { a: 'coalbrookdale', b: 'kidderminster', canal: true, rail: true }, // 20
  { a: 'coalbrookdale', b: 'shrewsbury', canal: true, rail: true }, // 21
  { a: 'coalbrookdale', b: 'wolverhampton', canal: true, rail: true }, // 22
  { a: 'coventry', b: 'nuneaton', canal: false, rail: true }, // 23
  { a: 'derby', b: 'nottingham', canal: true, rail: true }, // 24
  { a: 'derby', b: 'uttoxeter', canal: false, rail: true }, // 25
  { a: 'dudley', b: 'kidderminster', canal: true, rail: true }, // 26
  { a: 'dudley', b: 'wolverhampton', canal: true, rail: true }, // 27
  { a: 'gloucester', b: 'redditch', canal: true, rail: true }, // 28
  { a: 'gloucester', b: 'worcester', canal: true, rail: true }, // 29
  { a: 'kidderminster', b: 'worcester', canal: true, rail: true }, // 30（同时连接 farm-south，见 LINK_EXTRA_ENDPOINTS）
  { a: 'leek', b: 'stoke-on-trent', canal: true, rail: true }, // 31
  { a: 'nuneaton', b: 'tamworth', canal: true, rail: true }, // 32
  { a: 'redditch', b: 'oxford', canal: true, rail: true }, // 33
  { a: 'stafford', b: 'stone', canal: true, rail: true }, // 34
  { a: 'stoke-on-trent', b: 'stone', canal: true, rail: true }, // 35
  { a: 'stoke-on-trent', b: 'warrington', canal: true, rail: true }, // 36
  { a: 'stone', b: 'uttoxeter', canal: false, rail: true }, // 37
  { a: 'tamworth', b: 'walsall', canal: false, rail: true }, // 38
  { a: 'walsall', b: 'wolverhampton', canal: true, rail: true }, // 39
];

/**
 * 三端点边的额外端点（0 基下标 → 额外连接的地点）。
 * #30 Kidderminster–Worcester 是同一条 Link 同时连接南部农场酿酒厂，
 * 建模为主端点 kidderminster/worcester + 额外端点 farm-south [R p.9]。
 */
export const LINK_EXTRA_ENDPOINTS: Record<number, LocationId[]> = {
  29: ['farm-south'],
};

// §1.3：5 个商人位。
export const MERCHANTS: Record<MerchantId, MerchantDef> = {
  shrewsbury: { slots: 1, bonus: { type: 'vp', amount: 4 }, links: ['coalbrookdale'] },
  gloucester: { slots: 2, bonus: { type: 'develop', amount: 1 }, links: ['redditch', 'worcester'] },
  oxford: { slots: 2, bonus: { type: 'income', amount: 2 }, links: ['birmingham', 'redditch'] },
  warrington: { slots: 2, bonus: { type: 'money', amount: 5 }, links: ['stoke-on-trent'] },
  nottingham: { slots: 2, bonus: { type: 'vp', amount: 3 }, links: ['derby'] },
};

/** 某节点在指定时代的相邻节点（含三端点边的额外端点）。 */
export function neighborsOf(id: LocationId | MerchantId, era: Era): (LocationId | MerchantId)[] {
  const out: (LocationId | MerchantId)[] = [];
  for (let i = 0; i < LINKS.length; i++) {
    const link = LINKS[i]!;
    if (era === 'canal' ? !link.canal : !link.rail) continue;
    const endpoints: (LocationId | MerchantId)[] = [link.a, link.b, ...(LINK_EXTRA_ENDPOINTS[i] ?? [])];
    if (!endpoints.includes(id)) continue;
    for (const e of endpoints) {
      if (e !== id) out.push(e);
    }
  }
  return out;
}
