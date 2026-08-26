/**
 * 审计域 I（静态数据）独立核对测试。
 * 期望值独立转录自 docs/rules-reference.md §1–§5（[R][B][M][T][N] 多源核对版），
 * 不依赖引擎源码注释；任何一行不符即视为转录 bug。
 */
import { describe, expect, it } from 'vitest';
import { newGame } from '@brass/engine';
import { LOCATIONS, LINKS, MERCHANTS, LINK_EXTRA_ENDPOINTS, neighborsOf } from '../src/data/board.js';
import { buildDeck } from '../src/data/cards.js';
import { TILES } from '../src/data/tiles.js';
import {
  COAL_MARKET_PRICES,
  COAL_MARKET_INITIAL_FILLED,
  COAL_FALLBACK_PRICE,
  IRON_MARKET_PRICES,
  IRON_MARKET_INITIAL_FILLED,
  IRON_FALLBACK_PRICE,
  BREWERY_BARRELS,
} from '../src/data/market.js';
import {
  INCOME_LEVEL_SPACES,
  incomeLevelAt,
  loanBacktrack,
  INCOME_START_SPACE,
} from '../src/data/income.js';
import type { IndustryType, LocationId, MerchantId } from '../src/types.js';

// ---------- §1.1 地点与槽位（独立转录）----------
type Slot = IndustryType[];
const EXPECTED_LOCATIONS: Record<string, { name: string; region: string; slots: Slot[] }> = {
  belper: { name: 'Belper', region: 'derbyshire', slots: [['cotton', 'manufacturer'], ['coal'], ['pottery']] },
  derby: { name: 'Derby', region: 'derbyshire', slots: [['cotton', 'brewery'], ['cotton', 'manufacturer'], ['iron']] },
  leek: { name: 'Leek', region: 'staffordshire', slots: [['cotton', 'manufacturer'], ['cotton', 'coal']] },
  'stoke-on-trent': { name: 'Stoke-on-Trent', region: 'staffordshire', slots: [['cotton', 'manufacturer'], ['pottery', 'iron'], ['manufacturer']] },
  stone: { name: 'Stone', region: 'staffordshire', slots: [['cotton', 'brewery'], ['manufacturer', 'coal']] },
  uttoxeter: { name: 'Uttoxeter', region: 'staffordshire', slots: [['manufacturer', 'brewery'], ['cotton', 'brewery']] },
  stafford: { name: 'Stafford', region: 'midlands', slots: [['manufacturer', 'brewery'], ['pottery']] },
  'burton-on-trent': { name: 'Burton-on-Trent', region: 'midlands', slots: [['manufacturer', 'coal'], ['brewery']] },
  cannock: { name: 'Cannock', region: 'midlands', slots: [['manufacturer', 'coal'], ['coal']] },
  tamworth: { name: 'Tamworth', region: 'midlands', slots: [['cotton', 'coal'], ['cotton', 'coal']] },
  walsall: { name: 'Walsall', region: 'midlands', slots: [['iron', 'manufacturer'], ['manufacturer', 'brewery']] },
  wolverhampton: { name: 'Wolverhampton', region: 'black-country', slots: [['manufacturer'], ['manufacturer', 'coal']] },
  coalbrookdale: { name: 'Coalbrookdale', region: 'black-country', slots: [['iron', 'brewery'], ['iron'], ['coal']] },
  dudley: { name: 'Dudley', region: 'black-country', slots: [['coal'], ['iron']] },
  kidderminster: { name: 'Kidderminster', region: 'black-country', slots: [['cotton', 'coal'], ['cotton']] },
  worcester: { name: 'Worcester', region: 'black-country', slots: [['cotton'], ['cotton']] },
  birmingham: { name: 'Birmingham', region: 'birmingham', slots: [['cotton', 'manufacturer'], ['manufacturer'], ['iron'], ['manufacturer']] },
  coventry: { name: 'Coventry', region: 'birmingham', slots: [['pottery'], ['manufacturer', 'coal'], ['iron', 'manufacturer']] },
  nuneaton: { name: 'Nuneaton', region: 'birmingham', slots: [['manufacturer', 'brewery'], ['cotton', 'coal']] },
  redditch: { name: 'Redditch', region: 'birmingham', slots: [['manufacturer', 'coal'], ['iron']] },
  'farm-north': { name: 'Farm Brewery (North)', region: 'farm', slots: [['brewery']] },
  'farm-south': { name: 'Farm Brewery (South)', region: 'farm', slots: [['brewery']] },
};

// ---------- §1.2 39 条边（独立转录，顺序 = 表内 #）----------
const EXPECTED_LINKS: [string, string, boolean, boolean][] = [
  ['belper', 'derby', true, true], // 1
  ['belper', 'leek', false, true], // 2
  ['birmingham', 'coventry', true, true], // 3
  ['birmingham', 'dudley', true, true], // 4
  ['birmingham', 'nuneaton', false, true], // 5
  ['birmingham', 'oxford', true, true], // 6
  ['birmingham', 'redditch', false, true], // 7
  ['birmingham', 'tamworth', true, true], // 8
  ['birmingham', 'walsall', true, true], // 9
  ['birmingham', 'worcester', true, true], // 10
  ['burton-on-trent', 'cannock', false, true], // 11
  ['burton-on-trent', 'derby', true, true], // 12
  ['burton-on-trent', 'stone', true, true], // 13
  ['burton-on-trent', 'tamworth', true, true], // 14
  ['burton-on-trent', 'walsall', true, false], // 15
  ['cannock', 'stafford', true, true], // 16
  ['cannock', 'farm-north', true, true], // 17
  ['cannock', 'walsall', true, true], // 18
  ['cannock', 'wolverhampton', true, true], // 19
  ['coalbrookdale', 'kidderminster', true, true], // 20
  ['coalbrookdale', 'shrewsbury', true, true], // 21
  ['coalbrookdale', 'wolverhampton', true, true], // 22
  ['coventry', 'nuneaton', false, true], // 23
  ['derby', 'nottingham', true, true], // 24
  ['derby', 'uttoxeter', false, true], // 25
  ['dudley', 'kidderminster', true, true], // 26
  ['dudley', 'wolverhampton', true, true], // 27
  ['gloucester', 'redditch', true, true], // 28
  ['gloucester', 'worcester', true, true], // 29
  ['kidderminster', 'worcester', true, true], // 30（经 farm-south 三端点）
  ['leek', 'stoke-on-trent', true, true], // 31
  ['nuneaton', 'tamworth', true, true], // 32
  ['redditch', 'oxford', true, true], // 33
  ['stafford', 'stone', true, true], // 34
  ['stoke-on-trent', 'stone', true, true], // 35
  ['stoke-on-trent', 'warrington', true, true], // 36
  ['stone', 'uttoxeter', false, true], // 37
  ['tamworth', 'walsall', false, true], // 38
  ['walsall', 'wolverhampton', true, true], // 39
];

// ---------- §2.1–2.6 板块全表（独立转录）----------
interface Row {
  industry: IndustryType; level: number; count: number;
  costMoney: number; costCoal: number; costIron: number;
  beerToFlip: number; resourcesPlaced: number;
  vp: number; incomeAdvance: number; linkIcons: number;
  railEraBuildable: boolean; railEraOnly: boolean; developable: boolean;
}
const r = (x: Partial<Row> & Pick<Row, 'industry' | 'level' | 'count' | 'costMoney' | 'vp' | 'incomeAdvance' | 'linkIcons'>): Row => ({
  costCoal: 0, costIron: 0, beerToFlip: 0, resourcesPlaced: 0,
  railEraBuildable: true, railEraOnly: false, developable: true, ...x,
});
const EXPECTED_TILES: Row[] = [
  // §2.1 棉
  r({ industry: 'cotton', level: 1, count: 3, costMoney: 12, beerToFlip: 1, vp: 5, incomeAdvance: 5, linkIcons: 1, railEraBuildable: false }),
  r({ industry: 'cotton', level: 2, count: 2, costMoney: 14, costCoal: 1, beerToFlip: 1, vp: 5, incomeAdvance: 4, linkIcons: 2 }),
  r({ industry: 'cotton', level: 3, count: 3, costMoney: 16, costCoal: 1, costIron: 1, beerToFlip: 1, vp: 9, incomeAdvance: 3, linkIcons: 1 }),
  r({ industry: 'cotton', level: 4, count: 3, costMoney: 18, costCoal: 1, costIron: 1, beerToFlip: 1, vp: 12, incomeAdvance: 2, linkIcons: 1 }),
  // §2.2 制造
  r({ industry: 'manufacturer', level: 1, count: 1, costMoney: 8, costCoal: 1, beerToFlip: 1, vp: 3, incomeAdvance: 5, linkIcons: 2, railEraBuildable: false }),
  r({ industry: 'manufacturer', level: 2, count: 2, costMoney: 10, costIron: 1, beerToFlip: 1, vp: 5, incomeAdvance: 1, linkIcons: 1 }),
  r({ industry: 'manufacturer', level: 3, count: 1, costMoney: 12, costCoal: 2, vp: 4, incomeAdvance: 4, linkIcons: 0 }),
  r({ industry: 'manufacturer', level: 4, count: 1, costMoney: 8, costIron: 1, beerToFlip: 1, vp: 3, incomeAdvance: 6, linkIcons: 1 }),
  r({ industry: 'manufacturer', level: 5, count: 2, costMoney: 16, costCoal: 1, beerToFlip: 2, vp: 8, incomeAdvance: 2, linkIcons: 2 }),
  r({ industry: 'manufacturer', level: 6, count: 1, costMoney: 20, beerToFlip: 1, vp: 7, incomeAdvance: 6, linkIcons: 1 }),
  r({ industry: 'manufacturer', level: 7, count: 1, costMoney: 16, costCoal: 1, costIron: 1, vp: 9, incomeAdvance: 4, linkIcons: 0 }),
  r({ industry: 'manufacturer', level: 8, count: 2, costMoney: 20, costIron: 2, beerToFlip: 1, vp: 11, incomeAdvance: 1, linkIcons: 1 }),
  // §2.3 陶
  r({ industry: 'pottery', level: 1, count: 1, costMoney: 17, costIron: 1, beerToFlip: 1, vp: 10, incomeAdvance: 5, linkIcons: 1, developable: false }),
  r({ industry: 'pottery', level: 2, count: 1, costMoney: 0, costCoal: 1, beerToFlip: 1, vp: 1, incomeAdvance: 1, linkIcons: 1 }),
  r({ industry: 'pottery', level: 3, count: 1, costMoney: 22, costCoal: 2, beerToFlip: 2, vp: 11, incomeAdvance: 5, linkIcons: 1, developable: false }),
  r({ industry: 'pottery', level: 4, count: 1, costMoney: 0, costCoal: 1, beerToFlip: 1, vp: 1, incomeAdvance: 1, linkIcons: 1 }),
  r({ industry: 'pottery', level: 5, count: 1, costMoney: 24, costCoal: 2, beerToFlip: 2, vp: 20, incomeAdvance: 5, linkIcons: 1, railEraOnly: true }),
  // §2.4 煤
  r({ industry: 'coal', level: 1, count: 1, costMoney: 5, resourcesPlaced: 2, vp: 1, incomeAdvance: 4, linkIcons: 2, railEraBuildable: false }),
  r({ industry: 'coal', level: 2, count: 2, costMoney: 7, resourcesPlaced: 3, vp: 2, incomeAdvance: 7, linkIcons: 1 }),
  r({ industry: 'coal', level: 3, count: 2, costMoney: 8, costIron: 1, resourcesPlaced: 4, vp: 3, incomeAdvance: 6, linkIcons: 1 }),
  r({ industry: 'coal', level: 4, count: 2, costMoney: 10, costIron: 1, resourcesPlaced: 5, vp: 4, incomeAdvance: 5, linkIcons: 1 }),
  // §2.5 铁
  r({ industry: 'iron', level: 1, count: 1, costMoney: 5, costCoal: 1, resourcesPlaced: 4, vp: 3, incomeAdvance: 3, linkIcons: 1, railEraBuildable: false }),
  r({ industry: 'iron', level: 2, count: 1, costMoney: 7, costCoal: 1, resourcesPlaced: 4, vp: 5, incomeAdvance: 3, linkIcons: 1 }),
  r({ industry: 'iron', level: 3, count: 1, costMoney: 9, costCoal: 1, resourcesPlaced: 5, vp: 7, incomeAdvance: 2, linkIcons: 1 }),
  r({ industry: 'iron', level: 4, count: 1, costMoney: 12, costCoal: 1, resourcesPlaced: 6, vp: 9, incomeAdvance: 1, linkIcons: 1 }),
  // §2.6 酿
  r({ industry: 'brewery', level: 1, count: 2, costMoney: 5, costIron: 1, vp: 4, incomeAdvance: 4, linkIcons: 2, railEraBuildable: false }),
  r({ industry: 'brewery', level: 2, count: 2, costMoney: 7, costIron: 1, vp: 5, incomeAdvance: 5, linkIcons: 2 }),
  r({ industry: 'brewery', level: 3, count: 2, costMoney: 9, costIron: 1, vp: 7, incomeAdvance: 5, linkIcons: 2 }),
  r({ industry: 'brewery', level: 4, count: 1, costMoney: 9, costIron: 1, vp: 10, incomeAdvance: 5, linkIcons: 2, railEraOnly: true }),
];

describe('audit-I §1.1 地点槽位逐行核对', () => {
  it('22 个地点的名称/区域/槽位序列完全一致', () => {
    expect(Object.keys(LOCATIONS).sort()).toEqual(Object.keys(EXPECTED_LOCATIONS).sort());
    for (const [id, exp] of Object.entries(EXPECTED_LOCATIONS)) {
      const loc = LOCATIONS[id as LocationId]!;
      expect(loc.name, `${id} name`).toBe(exp.name);
      expect(loc.region, `${id} region`).toBe(exp.region);
      expect(
        loc.slots.map((s) => s.industries),
        `${id} slots`,
      ).toEqual(exp.slots);
    }
  });
});

describe('audit-I §1.2 连接边逐行核对', () => {
  it('39 条边端点与运河/铁路标志完全一致', () => {
    expect(LINKS).toHaveLength(39);
    for (let i = 0; i < 39; i++) {
      const [a, b, canal, rail] = EXPECTED_LINKS[i]!;
      expect(LINKS[i], `link #${i + 1}`).toEqual({ a, b, canal, rail });
    }
  });
  it('仅 #15 一条仅运河；#2/5/7/11/23/25/37/38 共 8 条仅铁路', () => {
    expect(LINKS.filter((l) => l.canal && !l.rail).map((l) => LINKS.indexOf(l))).toEqual([14]);
    expect(LINKS.filter((l) => !l.canal && l.rail).map((l) => LINKS.indexOf(l))).toEqual([1, 4, 6, 10, 22, 24, 36, 37]);
  });
  it('#30 经 LINK_EXTRA_ENDPOINTS 同时连接 farm-south（仅 1 条 Link）', () => {
    expect(LINK_EXTRA_ENDPOINTS).toEqual({ 29: ['farm-south'] });
    expect(neighborsOf('farm-south', 'canal').sort()).toEqual(['kidderminster', 'worcester']);
    expect(neighborsOf('farm-south', 'rail').sort()).toEqual(['kidderminster', 'worcester']);
  });
});

describe('audit-I §1.3 商人位定义', () => {
  it('槽位数/奖励/连接边', () => {
    expect(MERCHANTS.shrewsbury).toEqual({ slots: 1, bonus: { type: 'vp', amount: 4 }, links: ['coalbrookdale'] });
    expect(MERCHANTS.gloucester).toEqual({ slots: 2, bonus: { type: 'develop', amount: 1 }, links: ['redditch', 'worcester'] });
    expect(MERCHANTS.oxford).toEqual({ slots: 2, bonus: { type: 'income', amount: 2 }, links: ['birmingham', 'redditch'] });
    expect(MERCHANTS.warrington).toEqual({ slots: 2, bonus: { type: 'money', amount: 5 }, links: ['stoke-on-trent'] });
    expect(MERCHANTS.nottingham).toEqual({ slots: 2, bonus: { type: 'vp', amount: 3 }, links: ['derby'] });
  });
});

describe('audit-I §1.4/§8 商人板块构成与可用人数（经 newGame 实测）', () => {
  const tally = (pc: 2 | 3 | 4, seed: number) => {
    const s = newGame(pc, seed);
    const all = Object.values(s.merchants).flatMap((m) => m.tiles);
    const count = (t: string) => all.filter((x) => x === t).length;
    return { s, all, count };
  };
  it('2p = 5 块 {any, cotton, manufacturer, blank×2}；Warrington/Nottingham 无板块', () => {
    for (const seed of [1, 42, 777]) {
      const { s, all, count } = tally(2, seed);
      expect(all).toHaveLength(5);
      expect(count('any')).toBe(1);
      expect(count('cotton')).toBe(1);
      expect(count('manufacturer')).toBe(1);
      expect(count('pottery')).toBe(0);
      expect(count('blank')).toBe(2);
      expect(s.merchants.warrington.tiles).toEqual([]);
      expect(s.merchants.nottingham.tiles).toEqual([]);
    }
  });
  it('3p = 7 块（2p + {pottery, blank}）；Nottingham 无板块', () => {
    for (const seed of [1, 42, 777]) {
      const { s, all, count } = tally(3, seed);
      expect(all).toHaveLength(7);
      expect(count('pottery')).toBe(1);
      expect(count('blank')).toBe(3);
      expect(s.merchants.warrington.tiles).toHaveLength(2);
      expect(s.merchants.nottingham.tiles).toEqual([]);
    }
  });
  it('4p = 9 块（3p + {cotton, manufacturer}），5 位全放', () => {
    for (const seed of [1, 42, 777]) {
      const { s, all, count } = tally(4, seed);
      expect(all).toHaveLength(9);
      expect(count('any')).toBe(1);
      expect(count('cotton')).toBe(2);
      expect(count('manufacturer')).toBe(2);
      expect(count('pottery')).toBe(1);
      expect(count('blank')).toBe(3);
      for (const m of Object.values(s.merchants)) expect(m.tiles.length).toBeGreaterThan(0);
    }
  });
  it('啤酒桶只放非 blank 板块旁（[R p.4] 步骤 6 "(non-blank)"）', () => {
    for (const pc of [2, 3, 4] as const) {
      const s = newGame(pc, 12345);
      for (const m of Object.values(s.merchants)) {
        expect(m.barrels.filter(Boolean).length).toBe(m.tiles.filter((t) => t !== 'blank').length);
      }
    }
  });
  it('每位商人位的板块数不超过其槽位数', () => {
    for (const pc of [2, 3, 4] as const) {
      const s = newGame(pc, 999);
      for (const [id, def] of Object.entries(MERCHANTS)) {
        expect(s.merchants[id as MerchantId]!.tiles.length).toBeLessThanOrEqual(def.slots);
      }
    }
  });
});

describe('audit-I §2 板块全表逐行核对', () => {
  it('29 行全部字段一致', () => {
    expect(TILES).toHaveLength(29);
    for (const exp of EXPECTED_TILES) {
      const t = TILES.find((x) => x.industry === exp.industry && x.level === exp.level);
      expect(t, `${exp.industry} L${exp.level}`).toMatchObject(exp);
    }
  });
  it('总数 45 = 棉11/制造11/酿7/陶5/铁4/煤7', () => {
    const by = (i: IndustryType) => TILES.filter((t) => t.industry === i).reduce((s, t) => s + t.count, 0);
    expect(TILES.reduce((s, t) => s + t.count, 0)).toBe(45);
    expect(by('cotton')).toBe(11);
    expect(by('manufacturer')).toBe(11);
    expect(by('brewery')).toBe(7);
    expect(by('pottery')).toBe(5);
    expect(by('iron')).toBe(4);
    expect(by('coal')).toBe(7);
  });
});

describe('audit-I §3 牌组构成', () => {
  const locCount = (deck: ReturnType<typeof buildDeck>, loc: string) =>
    deck.filter((c) => c.kind === 'location' && c.location === loc).length;
  const indCount = (deck: ReturnType<typeof buildDeck>, ...inds: IndustryType[]) =>
    deck.filter((c) => c.kind === 'industry' && c.industries.join(',') === inds.join(',')).length;

  it('4p = 64 张逐卡明细', () => {
    const d = buildDeck(4);
    expect(d).toHaveLength(64);
    // Location 41：3 张组 ×5、2 张组 ×11、1 张组 ×4
    for (const l of ['birmingham', 'coventry', 'coalbrookdale', 'derby', 'stoke-on-trent'])
      expect(locCount(d, l), l).toBe(3);
    for (const l of ['belper', 'leek', 'stone', 'uttoxeter', 'stafford', 'burton-on-trent', 'cannock', 'dudley', 'kidderminster', 'wolverhampton', 'worcester'])
      expect(locCount(d, l), l).toBe(2);
    for (const l of ['tamworth', 'walsall', 'nuneaton', 'redditch'])
      expect(locCount(d, l), l).toBe(1);
    expect(d.filter((c) => c.kind === 'location')).toHaveLength(41);
    // Industry：iron 4 / coal 3 / pottery 3 / brewery 5 + 双图标 8
    expect(indCount(d, 'iron')).toBe(4);
    expect(indCount(d, 'coal')).toBe(3);
    expect(indCount(d, 'pottery')).toBe(3);
    expect(indCount(d, 'brewery')).toBe(5);
    expect(indCount(d, 'cotton', 'manufacturer')).toBe(8);
    // 不存在单独的棉卡/制造卡
    expect(indCount(d, 'cotton')).toBe(0);
    expect(indCount(d, 'manufacturer')).toBe(0);
  });
  it('3p = 54：移除青(Belper2/Derby3) + Uttoxeter1 + Coal1 + Pottery1 + 双图标2', () => {
    const d = buildDeck(3);
    expect(d).toHaveLength(54);
    expect(locCount(d, 'belper')).toBe(0);
    expect(locCount(d, 'derby')).toBe(0);
    expect(locCount(d, 'uttoxeter')).toBe(1);
    expect(d.filter((c) => c.kind === 'location')).toHaveLength(35);
    expect(indCount(d, 'coal')).toBe(2);
    expect(indCount(d, 'pottery')).toBe(2);
    expect(indCount(d, 'iron')).toBe(4);
    expect(indCount(d, 'brewery')).toBe(5);
    expect(indCount(d, 'cotton', 'manufacturer')).toBe(6);
  });
  it('2p = 40：再移除全部蓝(Leek2/Stoke3/Stone2/Uttoxeter1) + 双图标 0', () => {
    const d = buildDeck(2);
    expect(d).toHaveLength(40);
    expect(d.filter((c) => c.kind === 'location')).toHaveLength(27);
    expect(indCount(d, 'iron')).toBe(4);
    expect(indCount(d, 'coal')).toBe(2);
    expect(indCount(d, 'pottery')).toBe(2);
    expect(indCount(d, 'brewery')).toBe(5);
    expect(indCount(d, 'cotton', 'manufacturer')).toBe(0);
  });
  it('横幅色移除规则与 LOCATIONS 区域数据自洽（[R p.4]）', () => {
    // 2p 移除 derbyshire(teal)+staffordshire(蓝)；3p 移除 derbyshire(teal)
    const locRegions = new Map(Object.entries(LOCATIONS).map(([id, l]) => [id, l.region]));
    for (const c of buildDeck(2)) {
      if (c.kind !== 'location') continue;
      expect(['derbyshire', 'staffordshire']).not.toContain(locRegions.get(c.location));
    }
    for (const c of buildDeck(3)) {
      if (c.kind !== 'location') continue;
      expect(locRegions.get(c.location)).not.toBe('derbyshire');
    }
  });
  it('newGame 牌堆守恒：手牌 + 弃牌堆底 + 抽牌堆 = 牌堆总量', () => {
    for (const [pc, total] of [[2, 40], [3, 54], [4, 64]] as const) {
      const s = newGame(pc, 7);
      const inHands = s.players.reduce((n, p) => n + p.hand.length, 0);
      expect(inHands + s.discard.length + s.deck.length).toBe(total);
    }
  });
});

describe('audit-I §4 收入轨映射', () => {
  it('起始格 10 = 等级 0', () => {
    expect(INCOME_START_SPACE).toBe(10);
    expect(incomeLevelAt(10)).toBe(0);
  });
  it('逐格映射：0-10 每级 1 格 / 11-30 每级 2 格 / 31-60 每级 3 格 / 61-96 每级 4 格 / 97-99 = 30', () => {
    // 全 100 格逐一验证
    const expectLevel = (space: number): number => {
      if (space <= 10) return space - 10;
      if (space <= 30) return Math.ceil((space - 10) / 2);
      if (space <= 60) return 10 + Math.ceil((space - 30) / 3);
      if (space <= 96) return 20 + Math.ceil((space - 60) / 4);
      return 30;
    };
    for (let s = 0; s <= 99; s++) expect(incomeLevelAt(s), `space ${s}`).toBe(expectLevel(s));
    // 每级所占格数
    const bandSize = (lvl: number) => INCOME_LEVEL_SPACES(lvl)[1] - INCOME_LEVEL_SPACES(lvl)[0] + 1;
    for (let l = -10; l <= 0; l++) expect(bandSize(l)).toBe(1);
    for (let l = 1; l <= 10; l++) expect(bandSize(l)).toBe(2);
    for (let l = 11; l <= 20; l++) expect(bandSize(l)).toBe(3);
    for (let l = 21; l <= 29; l++) expect(bandSize(l)).toBe(4);
    expect(INCOME_LEVEL_SPACES(30)).toEqual([97, 99]);
    // 格区间无缝覆盖 0..99
    let cursor = 0;
    for (let l = -10; l <= 30; l++) {
      expect(INCOME_LEVEL_SPACES(l)[0]).toBe(cursor);
      cursor = INCOME_LEVEL_SPACES(l)[1] + 1;
    }
    expect(cursor).toBe(100);
  });
  it('贷款退 3 个等级（非格），落新等级最高格，下限 -10', () => {
    expect(loanBacktrack(10)).toBe(7); // level 0 → -3
    expect(loanBacktrack(11)).toBe(8); // level 1 → -2（space 8 = level -2 唯一格）
    expect(loanBacktrack(0)).toBe(0); // 已在下限
    expect(loanBacktrack(97)).toBe(INCOME_LEVEL_SPACES(27)[1]); // level 30 → 27
  });
});

describe('audit-I §5 市场常量', () => {
  it('煤 14 格 £1-7 各 2；初始 13；兜底 £8', () => {
    expect(COAL_MARKET_PRICES).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
    expect(COAL_MARKET_INITIAL_FILLED).toBe(13);
    expect(COAL_FALLBACK_PRICE).toBe(8);
  });
  it('铁 10 格 £1-5 各 2；初始 8；兜底 £6', () => {
    expect(IRON_MARKET_PRICES).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(IRON_MARKET_INITIAL_FILLED).toBe(8);
    expect(IRON_FALLBACK_PRICE).toBe(6);
  });
  it('酿酒厂放桶按时代：运河 1 / 铁路 2', () => {
    expect(BREWERY_BARRELS).toEqual({ canal: 1, rail: 2 });
  });
  it('newGame 初始市场填充正确', () => {
    const s = newGame(4, 3);
    expect(s.coalMarket).toBe(13);
    expect(s.ironMarket).toBe(8);
  });
});
