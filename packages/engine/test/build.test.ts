import { describe, expect, it } from 'vitest';
import { enumerateBuilds, applyBuild } from '../src/actions/build.js';
import { IllegalActionError } from '../src/errors.js';
import { newGame, type GameState, type PlacedTile } from '../src/state.js';
import { LOCATIONS } from '../src/data/board.js';
import { tileDef } from '../src/data/tiles.js';
import type { Card } from '../src/data/cards.js';
import type { Action, IndustryType, LocationId, PlayerIndex } from '../src/types.js';

// 数值锚点：起始 £17 / 收入格 10；煤市场 14 格 filled 13（空格 £1）；
// 铁市场 10 格 filled 8（空格 £1×2）。coal L1 £5 放 2 块 income+4；
// iron L1 £5+1 煤 放 4 块 income+3；brewery L1 £5+1 铁；cotton L1 £12；pottery L1 £17+1 铁。

const locCard = (location: LocationId, id = `loc-${location}-test`): Card => ({
  id,
  kind: 'location',
  location,
});
const indCard = (industries: IndustryType[], id = `ind-${industries.join('-')}-test`): Card => ({
  id,
  kind: 'industry',
  industries,
});

function setHand(s: GameState, player: PlayerIndex, cards: Card[]): void {
  s.players[player]!.hand = cards;
}

function findSlot(loc: LocationId, industry: IndustryType): number {
  const slots = LOCATIONS[loc]!.slots;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]!.industries.includes(industry)) return i;
  }
  throw new Error(`no slot for ${industry} at ${loc}`);
}

/** 手工放置板块（绕过建造校验）。默认 level 1、未翻面、按 TileDef.resourcesPlaced 放资源。 */
function withTile(
  s: GameState,
  player: PlayerIndex,
  loc: LocationId,
  industry: IndustryType,
  opts: { level?: number; resources?: number; flipped?: boolean; slot?: number } = {},
): PlacedTile {
  const def = tileDef(industry, opts.level ?? 1);
  if (!def) throw new Error('missing tile def');
  const slot = opts.slot ?? findSlot(loc, industry);
  const placed: PlacedTile = {
    tile: def,
    player,
    flipped: opts.flipped ?? false,
    resources: opts.resources ?? def.resourcesPlaced,
  };
  s.board.slots[loc]![slot] = placed;
  return placed;
}

/** 手工铺一条 Link（linkIndex 0 基）。 */
function withLink(s: GameState, linkIndex: number, player: PlayerIndex): void {
  s.board.links.push({ linkIndex, player });
}

const builds = (acts: Action[]): Extract<Action, { type: 'build' }>[] =>
  acts.filter((a): a is Extract<Action, { type: 'build' }> => a.type === 'build');
const buildsAt = (acts: Action[], loc: LocationId) => builds(acts).filter((a) => a.location === loc);
const industriesAt = (acts: Action[], loc: LocationId) =>
  new Set(buildsAt(acts, loc).map((a) => a.industry));

describe('enumerateBuilds: card rules', () => {
  it('location card allows building outside network', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [locCard('worcester', 'loc-worcester-0')]);
    const acts = enumerateBuilds(s, 0);
    expect(
      acts.some((a) => a.type === 'build' && a.location === 'worcester' && a.industry === 'cotton'),
    ).toBe(true);
  });

  it('industry card: with no tiles on board can build anywhere; once placed, network-restricted', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [indCard(['coal'], 'ind-coal-0')]);
    // 规则 §6.1：场上无任何板块时产业卡可建任意合法地点
    expect(enumerateBuilds(s, 0).length).toBeGreaterThan(0);
    // 在 dudley 放一块自己的板块后：只能建 dudley 及其 link 可达处
    withTile(s, 0, 'dudley', 'coal');
    // 面板最低煤 = L2（同级不可覆盖，L2 > L1 才能覆盖 dudley 的 L1 矿）
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    const acts = enumerateBuilds(s, 0);
    const locations = new Set(acts.map((a) => (a.type === 'build' ? a.location : '')));
    expect(
      [...locations].every((l) =>
        ['dudley', 'birmingham', 'kidderminster', 'wolverhampton'].includes(l),
      ),
    ).toBe(true);
    expect(locations.has('dudley')).toBe(true); // 覆盖自己在 dudley 的矿
  });

  it('first-build special case is per-player: opponent tiles do not close it', () => {
    const s = newGame(4, 5);
    withTile(s, 1, 'dudley', 'coal'); // 对手已有板块，自己无板块无 Link
    setHand(s, 0, [indCard(['coal'], 'ind-coal-0')]);
    // 特例仍生效：可建任意合法地点（dudley 矿槽被对手占且全图煤未归零 → dudley 除外）
    const locations = new Set(builds(enumerateBuilds(s, 0)).map((a) => a.location));
    expect(locations.has('cannock')).toBe(true);
    expect(locations.has('dudley')).toBe(false);
    // 自己有 Link（无板块）后特例关闭：network = link 端点
    withLink(s, 3, 0); // 自己铺 #4 birmingham-dudley
    const after = new Set(builds(enumerateBuilds(s, 0)).map((a) => a.location));
    expect(after.has('cannock')).toBe(false);
  });

  it('industry card only reaches locations connected to own network via built links', () => {
    const s = newGame(4, 5);
    withTile(s, 0, 'dudley', 'coal');
    withLink(s, 3, 1); // #4 birmingham-dudley（对手铺的也算连通）
    setHand(s, 0, [indCard(['cotton'], 'ind-cotton-0')]);
    const locations = new Set(builds(enumerateBuilds(s, 0)).map((a) => a.location));
    expect(locations.has('birmingham')).toBe(true); // 沿已建边可达
    expect(locations.has('worcester')).toBe(false); // 无可达路径（dudley 无棉槽且未连通）
    expect(locations.has('wolverhampton')).toBe(false); // 相邻但边未建
  });

  it('dual-icon industry card offers both industries', () => {
    const s = newGame(4, 5);
    withLink(s, 5, 1); // #6 birmingham-oxford：制造 L1 需 1 煤，须有市场连通
    setHand(s, 0, [indCard(['cotton', 'manufacturer'], 'ind-cotton-manufacturer-0')]);
    const atWorcester = industriesAt(enumerateBuilds(s, 0), 'worcester');
    expect(atWorcester.has('cotton')).toBe(true);
    expect(atWorcester.has('manufacturer')).toBe(false); // worcester 无制造槽
    const atBirmingham = industriesAt(enumerateBuilds(s, 0), 'birmingham');
    expect(atBirmingham.has('cotton')).toBe(true);
    expect(atBirmingham.has('manufacturer')).toBe(true);
  });

  it('wild location card works at any named location but not farms', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [{ id: 'wild-location-0', kind: 'wild-location' }]);
    const locations = new Set(builds(enumerateBuilds(s, 0)).map((a) => a.location));
    expect(locations.has('belper')).toBe(true);
    expect(locations.has('worcester')).toBe(true);
    expect(locations.has('farm-north')).toBe(false);
    expect(locations.has('farm-south')).toBe(false);
  });

  it('farm brewery rejects wild-location card; accepts industry/wild-industry cards', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [{ id: 'wild-location-0', kind: 'wild-location' }]);
    expect(buildsAt(enumerateBuilds(s, 0), 'farm-north').length).toBe(0);

    setHand(s, 0, [indCard(['brewery'], 'ind-brewery-0')]);
    const farms = industriesAt(enumerateBuilds(s, 0), 'farm-north');
    expect([...farms]).toEqual(['brewery']); // 空板特例 → 可建农场

    setHand(s, 0, [{ id: 'wild-industry-0', kind: 'wild-industry' }]);
    const farmsWild = industriesAt(enumerateBuilds(s, 0), 'farm-south');
    expect(farmsWild.has('brewery')).toBe(true);
  });

  it('industry brewery card cannot reach unconnected farm once board non-empty', () => {
    const s = newGame(4, 5);
    withTile(s, 0, 'dudley', 'coal'); // network 只有 dudley
    setHand(s, 0, [indCard(['brewery'], 'ind-brewery-0')]);
    expect(buildsAt(enumerateBuilds(s, 0), 'farm-north').length).toBe(0);
    expect(buildsAt(enumerateBuilds(s, 0), 'farm-south').length).toBe(0);
    // cannock 铺到 farm-north 的边后可达（cannock 与 dudley 未连通则仍不可达；
    // 这里直接让 dudley 与 farm 无关——只验证不通时不可建）
  });
});

describe('enumerateBuilds: slots, era, panel, affordability', () => {
  it('empty slot preference: single-icon slot before dual-icon slot', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [locCard('cannock')]);
    // cannock: slot0 [manufacturer,coal]（双图标）、slot1 [coal]（单图标）→ 煤建 slot1
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-cannock-test', industry: 'coal', location: 'cannock' });
    expect(r.state.board.slots['cannock']![0]).toBeNull();
    expect(r.state.board.slots['cannock']![1]!.tile.industry).toBe('coal');
  });

  it('dual-icon slot used when no single-icon slot matches', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [locCard('belper')]);
    // belper: slot0 [cotton,manufacturer]、slot1 [coal]、slot2 [pottery] → 棉只能进 slot0
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-belper-test', industry: 'cotton', location: 'belper' });
    expect(r.state.board.slots['belper']![0]!.tile.industry).toBe('cotton');
  });

  it('canal era: at most one own tile per location (no second tile, overbuild still possible)', () => {
    const s = newGame(4, 5);
    withTile(s, 0, 'birmingham', 'iron', { slot: 2 }); // 自己铁厂已占 birmingham
    // 面板最低铁 = L2（同级不可覆盖，L2 > L1 才能覆盖自己的 L1 铁厂）
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'iron' || t.level >= 2);
    setHand(s, 0, [locCard('birmingham')]);
    const inds = industriesAt(enumerateBuilds(s, 0), 'birmingham');
    expect(inds.has('cotton')).toBe(false); // 空槽在但运河时代限 1 块
    expect(inds.has('manufacturer')).toBe(false);
    // 覆盖自己的铁厂：铁槽被自己占 → overbuild 合法（铁 L2 £7+1煤，无连通→煤买不起……给连通）
    expect(inds.has('iron')).toBe(false); // 无煤连通 → 不可行
    withLink(s, 5, 1); // #6 birmingham-oxford → 连通商人位
    expect(industriesAt(enumerateBuilds(s, 0), 'birmingham').has('iron')).toBe(true);
  });

  it('rail era: no per-location own-tile limit', () => {
    const s = newGame(4, 5);
    s.era = 'rail';
    withTile(s, 0, 'birmingham', 'iron', { slot: 2, level: 2 });
    // 面板最低制造 = L2（L1 铁路禁建，模拟已移除）
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'manufacturer' || t.level >= 2);
    setHand(s, 0, [locCard('birmingham')]);
    s.players[0]!.money = 40;
    const inds = industriesAt(enumerateBuilds(s, 0), 'birmingham');
    expect(inds.has('manufacturer')).toBe(true); // 第 2 块合法
  });

  it('cannot build level-1 cotton in rail era; can build pottery 1', () => {
    const s = newGame(4, 5);
    s.era = 'rail';
    s.players[0]!.money = 40;
    setHand(s, 0, [locCard('worcester'), locCard('coventry', 'loc-coventry-test')]);
    const acts = enumerateBuilds(s, 0);
    expect(industriesAt(acts, 'worcester').has('cotton')).toBe(false); // L1 棉铁路禁建
    expect(industriesAt(acts, 'coventry').has('pottery')).toBe(true); // L1 陶例外可建
  });

  it('railEraOnly tiles (pottery 5 / brewery 4) unbuildable in canal era', () => {
    const s = newGame(4, 5);
    s.players[0]!.money = 60;
    // 面板只留 pottery L5 / brewery L4（模拟 Develop 移除低级）
    s.players[0]!.tiles = s.players[0]!.tiles.filter(
      (t) => (t.industry === 'pottery' ? t.level === 5 : t.industry === 'brewery' ? t.level === 4 : false),
    );
    setHand(s, 0, [locCard('burton-on-trent')]); // slot1 [brewery]
    expect(industriesAt(enumerateBuilds(s, 0), 'burton-on-trent').has('brewery')).toBe(false);
    s.era = 'rail';
    expect(industriesAt(enumerateBuilds(s, 0), 'burton-on-trent').has('brewery')).toBe(true);
  });

  it('panel exhausted for an industry → no actions for it', () => {
    const s = newGame(4, 5);
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'cotton');
    setHand(s, 0, [locCard('worcester')]);
    expect(enumerateBuilds(s, 0).length).toBe(0); // worcester 只有棉槽
  });

  it('insufficient funds → action not enumerated', () => {
    const s = newGame(4, 5);
    s.players[0]!.money = 5;
    setHand(s, 0, [locCard('worcester')]);
    expect(buildsAt(enumerateBuilds(s, 0), 'worcester').length).toBe(0); // 棉 L1 £12
  });

  it('coal cost without merchant connection → action not enumerated', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [locCard('coalbrookdale')]);
    // 铁 L1 需 1 煤；coalbrookdale 无 link → 不可市场买煤 → 无铁行动
    expect(industriesAt(enumerateBuilds(s, 0), 'coalbrookdale').has('iron')).toBe(false);
    withLink(s, 20, 1); // #21 coalbrookdale-shrewsbury
    expect(industriesAt(enumerateBuilds(s, 0), 'coalbrookdale').has('iron')).toBe(true);
  });
});

describe('overbuild', () => {
  it('canal era: opponent overbuild cannot place a second own tile at a location', () => {
    const s = newGame(4, 5);
    s.coalMarket = 0; // 全图煤归零
    // 己方铁厂（[iron] 槽，不含煤图标→不是煤 overbuild 候选）+ 对手耗尽煤矿（[coal] 槽）
    withTile(s, 0, 'coalbrookdale', 'iron', { slot: 1 });
    withTile(s, 1, 'coalbrookdale', 'coal', { slot: 2, resources: 0, flipped: true });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    setHand(s, 0, [locCard('coalbrookdale')]);
    // 运河时代：覆盖对手矿会在同地放第 2 块己方板块 → 不枚举
    expect(industriesAt(enumerateBuilds(s, 0), 'coalbrookdale').has('coal')).toBe(false);
    // 铁路时代（不限块数）→ 对手 overbuild 合法
    s.era = 'rail';
    expect(industriesAt(enumerateBuilds(s, 0), 'coalbrookdale').has('coal')).toBe(true);
  });

  it('overbuild requires same industry (own and opponent)', () => {
    // 对手跨产业：tamworth 两槽都是对手耗尽 L1 煤矿，棉 L2（等级够）也不可跨产业覆盖
    const s = newGame(4, 5);
    s.coalMarket = 0;
    withTile(s, 1, 'tamworth', 'coal', { slot: 0, resources: 0, flipped: true });
    withTile(s, 1, 'tamworth', 'coal', { slot: 1, resources: 0, flipped: true });
    s.players[0]!.tiles = s.players[0]!.tiles.filter(
      (t) => (t.industry === 'coal' ? t.level >= 2 : t.industry === 'cotton' ? t.level >= 2 : true),
    );
    withLink(s, 7, 1); // #8 birmingham-tamworth
    withLink(s, 5, 1); // #6 birmingham-oxford → 市场买煤连通（棉 L2 需 1 煤）
    s.players[0]!.money = 40;
    setHand(s, 0, [locCard('tamworth')]);
    const inds = industriesAt(enumerateBuilds(s, 0), 'tamworth');
    expect(inds.has('cotton')).toBe(false); // 棉盖对手煤矿 = 跨产业 → 非法
    expect(inds.has('coal')).toBe(true); // 同产业覆盖对手矿合法

    // 己方跨产业：[manufacturer,coal] 槽被己煤矿占，制造 L2（等级够）也不可跨产业覆盖
    const s2 = newGame(4, 5);
    withTile(s2, 0, 'cannock', 'coal', { slot: 0 });
    s2.players[0]!.tiles = s2.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    s2.players[0]!.money = 40;
    setHand(s2, 0, [locCard('cannock')]);
    const inds2 = industriesAt(enumerateBuilds(s2, 0), 'cannock');
    expect(inds2.has('manufacturer')).toBe(false); // 制造盖己煤矿 = 跨产业 → 非法
    expect(inds2.has('coal')).toBe(true); // 同产业覆盖己方矿合法
  });

  it('opponent overbuild is enumerated and preferred even when an empty slot exists', () => {
    const s = newGame(4, 5);
    s.era = 'rail';
    s.coalMarket = 0;
    withTile(s, 1, 'cannock', 'coal', { slot: 0, level: 2, resources: 0, flipped: true }); // 对手耗尽 L2 矿
    // slot1 [coal] 空槽可用；面板最低煤 = L3 > L2 → 对手 overbuild 非支配，优先于空槽
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 3);
    setHand(s, 0, [locCard('cannock')]);
    expect(buildsAt(enumerateBuilds(s, 0), 'cannock').some((a) => a.industry === 'coal')).toBe(true);
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-cannock-test', industry: 'coal', location: 'cannock' });
    // 执行的是对手覆盖（剥夺其二次计分），空槽保留
    expect(r.state.board.slots['cannock']![0]!.player).toBe(0);
    expect(r.state.board.slots['cannock']![0]!.tile.level).toBe(3);
    expect(r.state.board.slots['cannock']![1]).toBeNull();
    expect(r.state.players[0]!.money).toBe(7); // £8 + 市场铁 £2
  });

  it('overbuild opponent coal mine only when global coal cubes == 0 (incl. market)', () => {
    const s = newGame(4, 5);
    withTile(s, 1, 'dudley', 'coal', { resources: 1 }); // 对手矿有块
    setHand(s, 0, [locCard('dudley')]);
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(false);

    // 全图煤方块归零（市场清空 + 矿耗尽翻面）→ 可覆盖（面板最低煤 = L2 > 对手 L1）
    s.coalMarket = 0;
    withTile(s, 1, 'dudley', 'coal', { resources: 0, flipped: true });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(true);

    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-dudley-test', industry: 'coal', location: 'dudley' });
    const placedTile = r.state.board.slots['dudley']![0]!;
    expect(placedTile.player).toBe(0); // 对手板块被移出游戏
    expect(placedTile.tile.level).toBe(2);
    expect(placedTile.resources).toBe(3); // 不连通商人位 → 不卖市场
    expect(r.state.coalMarket).toBe(0);
  });

  it('§9.13: overbuilt tile resources return to supply — the new tile gets only its own cubes', () => {
    // 己方 L1 煤矿上还有 2 块煤；覆盖成 L2 后新矿只有自身的 3 块（不继承旧矿余块）
    const s = newGame(4, 5);
    withTile(s, 0, 'dudley', 'coal', { slot: 0, resources: 2 });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    withLink(s, 3, 1); // #4 birmingham-dudley
    withLink(s, 5, 1); // #6 birmingham-oxford → 新矿连通商人位，建成即卖
    setHand(s, 0, [locCard('dudley')]);
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-dudley-test', industry: 'coal', location: 'dudley' });
    const placed = r.state.board.slots['dudley']![0]!;
    expect(placed.tile.level).toBe(2);
    // L2 放 3 块、市场 1 空格卖出 1 块 → 恰好剩 2（若继承旧矿余块会变成 4）
    expect(placed.resources).toBe(2);
    expect(r.state.coalMarket).toBe(14);
  });

  it('overbuild requires strictly higher level (own and opponent)', () => {
    // 己方同级覆盖不出现在枚举中
    const s = newGame(4, 5);
    withTile(s, 0, 'worcester', 'cotton', { slot: 0, level: 1 });
    setHand(s, 0, [locCard('worcester')]);
    // 面板最低棉 = L1（同级）→ 不可覆盖；slot1 空槽但运河时代限 1 块
    expect(buildsAt(enumerateBuilds(s, 0), 'worcester').length).toBe(0);
    // 面板最低棉 = L2 后 → 覆盖合法（L2 需 1 煤 → 连通 gloucester 市场）
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'cotton' || t.level >= 2);
    withLink(s, 28, 1); // #29 gloucester-worcester
    expect(industriesAt(enumerateBuilds(s, 0), 'worcester').has('cotton')).toBe(true);

    // 对手板块同理：L2 矿不可被 L1 覆盖，可被 L3 覆盖
    const s2 = newGame(4, 5);
    s2.coalMarket = 0;
    withTile(s2, 1, 'dudley', 'coal', { level: 2, resources: 0, flipped: true });
    setHand(s2, 0, [locCard('dudley')]);
    expect(industriesAt(enumerateBuilds(s2, 0), 'dudley').has('coal')).toBe(false); // 面板最低煤 L1 < L2
    s2.players[0]!.tiles = s2.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 3);
    expect(industriesAt(enumerateBuilds(s2, 0), 'dudley').has('coal')).toBe(true); // L3 > L2
  });

  it('opponent cotton can never be overbuilt', () => {
    const s = newGame(4, 5);
    withTile(s, 1, 'worcester', 'cotton', { slot: 0 });
    withTile(s, 1, 'worcester', 'cotton', { slot: 1 });
    setHand(s, 0, [locCard('worcester')]);
    expect(buildsAt(enumerateBuilds(s, 0), 'worcester').length).toBe(0);
  });

  it('overbuild own tile in a dual-icon slot with a higher-level tile', () => {
    const s = newGame(4, 5);
    withTile(s, 0, 'cannock', 'manufacturer', { slot: 0 }); // [manufacturer,coal] 槽被自己制造占
    // 面板最低制造 = L2（同级不可覆盖，L2 > L1 才能覆盖）；L2 £10+1铁（市场买 £2）
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'manufacturer' || t.level >= 2);
    setHand(s, 0, [locCard('cannock')]);
    // 制造：slot1 是煤槽不匹配、slot0 被自己占 → 只能覆盖 slot0
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-cannock-test', industry: 'manufacturer', location: 'cannock' });
    expect(r.state.board.slots['cannock']![0]!.tile.industry).toBe('manufacturer');
    expect(r.state.board.slots['cannock']![0]!.tile.level).toBe(2);
    expect(r.state.board.slots['cannock']![0]!.flipped).toBe(false);
    expect(r.state.players[0]!.money).toBe(5); // 17 - 10 - 2(市场铁)
    expect(r.state.ironMarket).toBe(7);
  });

  it('rail era: multiple own same-industry tiles at one location → overbuild lowest level', () => {
    const s = newGame(4, 5);
    s.era = 'rail';
    withTile(s, 0, 'worcester', 'cotton', { slot: 0, level: 1, flipped: true });
    withTile(s, 0, 'worcester', 'cotton', { slot: 1, level: 2, flipped: false });
    // 面板最低棉 = L3（L1 铁路禁建）；L3 需 1 煤 1 铁 → 连通 gloucester 市场买煤
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'cotton' || t.level >= 3);
    withLink(s, 28, 1); // #29 gloucester-worcester
    setHand(s, 0, [locCard('worcester')]);
    s.players[0]!.money = 40;
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-worcester-test', industry: 'cotton', location: 'worcester' });
    // L1（slot0）被规范化选为覆盖目标；slot1 的 L2 原样保留
    expect(r.state.board.slots['worcester']![0]!.tile.level).toBe(3);
    expect(r.state.board.slots['worcester']![0]!.flipped).toBe(false);
    expect(r.state.board.slots['worcester']![1]!.tile.level).toBe(2);
    expect(r.state.board.slots['worcester']![1]!.flipped).toBe(false);
  });
});

describe('applyBuild execution', () => {
  it('rejects actions not produced by enumerateBuilds', () => {
    const s = newGame(4, 5);
    s.players[0]!.money = 0;
    setHand(s, 0, [locCard('worcester')]);
    expect(() =>
      applyBuild(s, 0, { type: 'build', cardId: 'loc-worcester-test', industry: 'cotton', location: 'worcester' }),
    ).toThrowError(IllegalActionError);
    expect(() =>
      applyBuild(s, 0, { type: 'build', cardId: 'loc-worcester-test', industry: 'cotton', location: 'worcester' }),
    ).toThrowError(/illegal-build/);
  });

  it('pays printed cost to spentThisRound, discards card, removes tile from panel', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [locCard('dudley')]);
    const discardBefore = s.discard.length;
    const coalL1Before = s.players[0]!.tiles.filter((t) => t.industry === 'coal' && t.level === 1).length;
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-dudley-test', industry: 'coal', location: 'dudley' });
    expect(r.state.players[0]!.money).toBe(12); // £5
    expect(r.state.players[0]!.spentThisRound).toBe(5);
    expect(r.state.players[0]!.hand.length).toBe(0);
    expect(r.state.discard.length).toBe(discardBefore + 1);
    expect(r.state.discard[r.state.discard.length - 1]!.id).toBe('loc-dudley-test');
    expect(r.state.players[0]!.tiles.filter((t) => t.industry === 'coal' && t.level === 1).length).toBe(coalL1Before - 1);
    const t = r.state.board.slots['dudley']![0]!;
    expect(t).toMatchObject({ player: 0, flipped: false, resources: 2 });
    expect(r.events).toEqual([]); // 不连通商人位 → 不卖不翻
    expect(r.state.coalMarket).toBe(13);
  });

  it('wild cards return to supply (not the discard pile)', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [{ id: 'wild-industry-0', kind: 'wild-industry' }]);
    s.wildSupply = { location: 4, industry: 3 }; // 手里这张 wild-industry 来自供应堆
    const discardBefore = s.discard.length;
    const r = applyBuild(s, 0, { type: 'build', cardId: 'wild-industry-0', industry: 'coal', location: 'dudley' });
    expect(r.state.players[0]!.hand.length).toBe(0);
    expect(r.state.discard.length).toBe(discardBefore); // §9.14
    expect(r.state.wildSupply).toEqual({ location: 4, industry: 4 }); // 回 wild 供应堆
  });

  it('wild location card returns to the location wild supply', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [{ id: 'wild-location-0', kind: 'wild-location' }]);
    s.wildSupply = { location: 3, industry: 4 };
    const discardBefore = s.discard.length;
    const r = applyBuild(s, 0, { type: 'build', cardId: 'wild-location-0', industry: 'coal', location: 'dudley' });
    expect(r.state.discard.length).toBe(discardBefore);
    expect(r.state.wildSupply).toEqual({ location: 4, industry: 4 });
  });

  it('brewery places barrels by era (canal 1 / rail 2)', () => {
    const s = newGame(4, 5);
    setHand(s, 0, [locCard('burton-on-trent')]);
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-burton-on-trent-test', industry: 'brewery', location: 'burton-on-trent' });
    expect(r.state.board.slots['burton-on-trent']![1]!.resources).toBe(1); // 单图标槽
    expect(r.state.players[0]!.money).toBe(10); // £5 + 市场买 1 铁 £2
    expect(r.state.players[0]!.spentThisRound).toBe(7);
    expect(r.state.ironMarket).toBe(7);

    const s2 = newGame(4, 5);
    s2.era = 'rail';
    s2.players[0]!.tiles = s2.players[0]!.tiles.filter((t) => t.industry !== 'brewery' || t.level >= 2);
    setHand(s2, 0, [locCard('burton-on-trent')]);
    const r2 = applyBuild(s2, 0, { type: 'build', cardId: 'loc-burton-on-trent-test', industry: 'brewery', location: 'burton-on-trent' });
    expect(r2.state.board.slots['burton-on-trent']![1]!.resources).toBe(2);
  });

  it('built iron works immediately sells to market; leftovers stay unflipped', () => {
    const s = newGame(4, 5);
    withLink(s, 20, 1); // #21 coalbrookdale-shrewsbury（煤连通）
    setHand(s, 0, [locCard('coalbrookdale')]);
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-coalbrookdale-test', industry: 'iron', location: 'coalbrookdale' });
    // 铁 L1 放 4 块 → 市场空格 2×£1 → 卖 2 块收 £2，剩 2 块不翻面
    expect(r.state.ironMarket).toBe(10);
    const t = r.state.board.slots['coalbrookdale']![1]!; // 单图标铁槽
    expect(t.resources).toBe(2);
    expect(t.flipped).toBe(false);
    expect(r.state.players[0]!.money).toBe(13); // 17 - 5 - 1(煤) + 2(卖铁)
    expect(r.state.players[0]!.spentThisRound).toBe(6);
    expect(r.events).toEqual([]);
  });

  it('iron works selling out flips immediately with income advance event', () => {
    const s = newGame(4, 5);
    s.ironMarket = 6; // 4 空格（£2,£2,£1,£1 自贵而廉卖出）
    withLink(s, 20, 1);
    setHand(s, 0, [locCard('coalbrookdale')]);
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-coalbrookdale-test', industry: 'iron', location: 'coalbrookdale' });
    const t = r.state.board.slots['coalbrookdale']![1]!;
    expect(t.resources).toBe(0);
    expect(t.flipped).toBe(true);
    expect(r.state.ironMarket).toBe(10);
    expect(r.state.players[0]!.money).toBe(17 - 5 - 1 + 6); // 卖 4 块收 £6
    expect(r.state.players[0]!.incomeSpace).toBe(13); // 10 + 3
    expect(r.events).toEqual([{ kind: 'flip', player: 0, location: 'coalbrookdale', incomeAdvance: 3 }]);
  });

  it('coal mine sells to market only when connected to a merchant space', () => {
    const s = newGame(4, 5);
    withLink(s, 3, 1); // #4 birmingham-dudley
    withLink(s, 5, 1); // #6 birmingham-oxford → dudley 连通商人位
    setHand(s, 0, [locCard('dudley')]);
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-dudley-test', industry: 'coal', location: 'dudley' });
    // 煤市场 1 空格 → 卖 1 块收 £1，剩 1 块不翻
    expect(r.state.coalMarket).toBe(14);
    const t = r.state.board.slots['dudley']![0]!;
    expect(t.resources).toBe(1);
    expect(t.flipped).toBe(false);
    expect(r.state.players[0]!.money).toBe(13); // 17 - 5 + 1
    expect(r.events).toEqual([]);
  });

  it('coal mine selling out flips immediately', () => {
    const s = newGame(4, 5);
    s.coalMarket = 12; // 2 空格
    withLink(s, 3, 1);
    withLink(s, 5, 1);
    setHand(s, 0, [locCard('dudley')]);
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-dudley-test', industry: 'coal', location: 'dudley' });
    const t = r.state.board.slots['dudley']![0]!;
    expect(t.resources).toBe(0);
    expect(t.flipped).toBe(true);
    expect(r.state.coalMarket).toBe(14);
    expect(r.state.players[0]!.money).toBe(17 - 5 + 2);
    expect(r.state.players[0]!.incomeSpace).toBe(14); // 10 + 4
    expect(r.events).toEqual([{ kind: 'flip', player: 0, location: 'dudley', incomeAdvance: 4 }]);
  });

  it('§9.7: mine/works leftovers are NOT sold to market on later actions (build-action only)', () => {
    const s = newGame(4, 5);
    withLink(s, 3, 1); // #4 birmingham-dudley
    withLink(s, 5, 1); // #6 birmingham-oxford → dudley 连通商人位
    setHand(s, 0, [locCard('dudley')]);
    const r1 = applyBuild(s, 0, { type: 'build', cardId: 'loc-dudley-test', industry: 'coal', location: 'dudley' });
    expect(r1.state.coalMarket).toBe(14); // 建成当次卖出 1 块，剩 1 块留矿上
    expect(r1.state.board.slots['dudley']![0]!.resources).toBe(1);
    // 之后的行动（另一玩家在别处建造）不再触发补卖：市场与矿上余块均不变
    setHand(r1.state, 1, [locCard('worcester')]);
    const r2 = applyBuild(r1.state, 1, { type: 'build', cardId: 'loc-worcester-test', industry: 'cotton', location: 'worcester' });
    expect(r2.state.coalMarket).toBe(14);
    expect(r2.state.board.slots['dudley']![0]!.resources).toBe(1);
    expect(r2.state.players[0]!.money).toBe(13); // 不再有卖煤收入
  });

  it('consumption flips drained sources before placement (opponent mine → owner income)', () => {
    const s = newGame(4, 5);
    withLink(s, 20, 1); // coalbrookdale-shrewsbury
    withTile(s, 1, 'coalbrookdale', 'coal', { slot: 2, resources: 1 }); // 对手矿 1 块
    setHand(s, 0, [locCard('coalbrookdale')]);
    const r = applyBuild(s, 0, { type: 'build', cardId: 'loc-coalbrookdale-test', industry: 'iron', location: 'coalbrookdale' });
    // 铁 L1 耗 1 煤 → 对手矿耗尽翻面（对手进收入）；铁厂自卖 2 块（剩 2 不翻）
    expect(r.events).toEqual([{ kind: 'flip', player: 1, location: 'coalbrookdale', incomeAdvance: 4 }]);
    expect(r.state.players[1]!.incomeSpace).toBe(14);
    expect(r.state.players[0]!.money).toBe(14); // 免费煤：17 - 5 + 2(卖铁)
  });

  it('does not mutate input state', () => {
    const s = newGame(4, 5);
    withLink(s, 20, 1);
    withTile(s, 1, 'coalbrookdale', 'coal', { slot: 2, resources: 1 });
    setHand(s, 0, [locCard('coalbrookdale')]);
    const snapshot = JSON.stringify(s);
    applyBuild(s, 0, { type: 'build', cardId: 'loc-coalbrookdale-test', industry: 'iron', location: 'coalbrookdale' });
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});
