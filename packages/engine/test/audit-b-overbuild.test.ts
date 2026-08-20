/**
 * 审计域 B：Overbuild 覆盖（规则书 p.10 / rules-reference §6.2）。
 * 逐条核对：
 *  ①同产业更高等级才可替换（同级/跨产业不可），照常付费耗资源 —— 现有 build.test.ts 已覆盖，
 *    本文件补充铁厂对手覆盖（现有套件只测了煤矿分支）。
 *  ②覆盖自己：任意产业（含酿酒厂）；被替换板块上的煤/铁/啤酒退回公共供应。
 *  ③覆盖对手：仅限煤/铁厂，且全版图（含市场）该类方块为 0。
 *  ④被覆盖板块移出游戏；已获收入/VP 不收回（含时代末不再计分）。
 *  ⑤overbuild 的卡/network 要求与普通 build 一致；无合法卡则不可覆盖。
 *  ⑥overbuild 是 replace：新板块进被替换板块的原槽位（槽位图标对已在槽内的板块天然成立）。
 *  ⑦运河时代"每地点限 1 块己方板块"：覆盖己方=替换不受限；覆盖对手=新增受禁；
 *    同地无己方板块时运河时代覆盖对手合法。
 */
import { describe, expect, it } from 'vitest';
import { enumerateBuilds, applyBuild } from '../src/actions/build.js';
import { scoreFlippedIndustries } from '../src/era.js';
import { newGame, type GameState, type PlacedTile } from '../src/state.js';
import { LOCATIONS } from '../src/data/board.js';
import { tileDef } from '../src/data/tiles.js';
import type { Card } from '../src/data/cards.js';
import type { Action, IndustryType, LocationId, PlayerIndex } from '../src/types.js';

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

function withLink(s: GameState, linkIndex: number, player: PlayerIndex): void {
  s.board.links.push({ linkIndex, player, era: s.era });
}

const builds = (acts: Action[]): Extract<Action, { type: 'build' }>[] =>
  acts.filter((a): a is Extract<Action, { type: 'build' }> => a.type === 'build');
const buildsAt = (acts: Action[], loc: LocationId) => builds(acts).filter((a) => a.location === loc);
const industriesAt = (acts: Action[], loc: LocationId) =>
  new Set(buildsAt(acts, loc).map((a) => a.industry));

describe('audit B: opponent overbuild — iron works branch (③)', () => {
  it('opponent iron works overbuild is legal when global iron == 0; income not revoked (③④)', () => {
    const s = newGame(4, 5);
    s.ironMarket = 0; // 市场铁清空
    // 对手 L1 铁厂已耗尽翻面（dudley slot1 [iron] 是唯一铁槽，无空铁槽干扰）
    withTile(s, 1, 'dudley', 'iron', { slot: 1, resources: 0, flipped: true });
    s.players[1]!.incomeSpace = 14; // 对手此前已获收入（被覆盖不得收回）
    // 面板最低铁 = L2（L2 > L1 才能覆盖）；L2 £7+1 煤
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'iron' || t.level >= 2);
    withLink(s, 3, 1); // #4 birmingham-dudley
    withLink(s, 5, 1); // #6 birmingham-oxford → dudley 连通商人位（买煤 £1）
    setHand(s, 0, [locCard('dudley')]);

    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('iron')).toBe(true);

    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-dudley-test',
      industry: 'iron',
      location: 'dudley',
    });
    const t = r.state.board.slots['dudley']![1]!;
    expect(t.player).toBe(0); // 对手铁厂被移出游戏
    expect(t.tile.level).toBe(2);
    // 新铁厂建成即无条件卖市场：空市场卖出 4 块（£5+£5+£4+£4=£18），卖空翻面
    expect(t.resources).toBe(0);
    expect(t.flipped).toBe(true);
    expect(r.state.ironMarket).toBe(4);
    expect(r.state.players[0]!.money).toBe(17 - 7 - 1 + 18);
    expect(r.events).toEqual([{ kind: 'flip', player: 0, location: 'dudley', incomeAdvance: 3 }]);
    expect(r.state.players[1]!.incomeSpace).toBe(14); // ④ 已获收入不收回
  });

  it('opponent iron overbuild blocked when iron market non-empty (③, 含市场)', () => {
    const s = newGame(4, 5);
    s.ironMarket = 3; // 市场上还有铁方块
    withTile(s, 1, 'dudley', 'iron', { slot: 1, resources: 0, flipped: true });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'iron' || t.level >= 2);
    withLink(s, 3, 1);
    withLink(s, 5, 1);
    setHand(s, 0, [locCard('dudley')]);
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('iron')).toBe(false);
  });

  it('opponent iron overbuild blocked by iron cubes on any other tile anywhere (③, 全版图)', () => {
    const s = newGame(4, 5);
    s.ironMarket = 0;
    withTile(s, 1, 'dudley', 'iron', { slot: 1, resources: 0, flipped: true });
    // 第三名玩家在 birmingham 的铁厂还有 1 块铁 → 全图铁未归零
    withTile(s, 2, 'birmingham', 'iron', { slot: 2, resources: 1 });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'iron' || t.level >= 2);
    withLink(s, 3, 1);
    withLink(s, 5, 1);
    setHand(s, 0, [locCard('dudley')]);
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('iron')).toBe(false);
    // 该铁厂也耗尽翻面后 → 全图铁归零 → 覆盖合法
    s.board.slots['birmingham']![2] = { ...s.board.slots['birmingham']![2]!, resources: 0, flipped: true };
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('iron')).toBe(true);
  });

  it('opponent coal overbuild blocked by coal cubes on a third player mine elsewhere (③, 全版图)', () => {
    const s = newGame(4, 5);
    s.coalMarket = 0;
    withTile(s, 1, 'dudley', 'coal', { slot: 0, resources: 0, flipped: true }); // 目标矿已耗尽
    withTile(s, 2, 'cannock', 'coal', { slot: 1, resources: 1 }); // 别处还有煤方块
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    setHand(s, 0, [locCard('dudley')]);
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(false);
    s.board.slots['cannock']![1] = { ...s.board.slots['cannock']![1]!, resources: 0, flipped: true };
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(true);
  });
});

describe('audit B: own overbuild (②)', () => {
  it('own brewery overbuild returns the barrel on the replaced tile to supply (②)', () => {
    const s = newGame(4, 5);
    // 自己的 L1 酒厂上还有 1 桶；覆盖成 L2 后新厂只有运河时代自身的 1 桶（不继承旧桶）
    withTile(s, 0, 'burton-on-trent', 'brewery', { slot: 1, resources: 1 });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'brewery' || t.level >= 2);
    setHand(s, 0, [locCard('burton-on-trent')]);
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-burton-on-trent-test',
      industry: 'brewery',
      location: 'burton-on-trent',
    });
    const t = r.state.board.slots['burton-on-trent']![1]!;
    expect(t.tile.level).toBe(2);
    expect(t.resources).toBe(1); // 运河时代 1 桶；若继承旧桶会变 2
    expect(r.state.players[0]!.money).toBe(17 - 7 - 2); // £7 + 市场买 1 铁 £2（照常付费 ①）
    expect(r.state.ironMarket).toBe(7);
  });

  it('own flipped tile can be overbuilt — "You may Overbuild any Industry tile" (②)', () => {
    const s = newGame(4, 5);
    // 自己已翻面的 L1 棉厂仍是 Industry tile，可被更高等级覆盖
    withTile(s, 0, 'worcester', 'cotton', { slot: 0, level: 1, flipped: true, resources: 0 });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'cotton' || t.level >= 2);
    withLink(s, 28, 1); // #29 gloucester-worcester → 市场买煤连通（棉 L2 需 1 煤）
    setHand(s, 0, [locCard('worcester')]);
    expect(industriesAt(enumerateBuilds(s, 0), 'worcester').has('cotton')).toBe(true);
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-worcester-test',
      industry: 'cotton',
      location: 'worcester',
    });
    const t = r.state.board.slots['worcester']![0]!;
    expect(t.tile.level).toBe(2);
    expect(t.flipped).toBe(false); // 新板块未翻面
    expect(r.state.players[0]!.money).toBe(17 - 14 - 1); // £14 + 市场煤 £1
  });

  it('era buildability filter applies to overbuild targets (railEraOnly brewery IV in canal era)', () => {
    const s = newGame(4, 5);
    // 自己 L3 酒厂；面板酒厂只剩 L4（模拟 Develop 移除）——L4 仅铁路时代可建
    withTile(s, 0, 'burton-on-trent', 'brewery', { slot: 1, level: 3, resources: 1 });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'brewery' || t.level >= 4);
    setHand(s, 0, [locCard('burton-on-trent')]);
    expect(industriesAt(enumerateBuilds(s, 0), 'burton-on-trent').has('brewery')).toBe(false);
    s.era = 'rail';
    expect(industriesAt(enumerateBuilds(s, 0), 'burton-on-trent').has('brewery')).toBe(true);
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-burton-on-trent-test',
      industry: 'brewery',
      location: 'burton-on-trent',
    });
    expect(r.state.board.slots['burton-on-trent']![1]!.tile.level).toBe(4);
    expect(r.state.board.slots['burton-on-trent']![1]!.resources).toBe(2); // 铁路时代 2 桶
  });
});

describe('audit B: overbuild follows normal build card/network rules (⑤)', () => {
  it('industry card cannot overbuild outside own network; location card can', () => {
    const s = newGame(4, 5);
    s.coalMarket = 0;
    // 对手耗尽 L1 煤矿占 tamworth slot0（slot1 仍为空槽）
    withTile(s, 1, 'tamworth', 'coal', { slot: 0, resources: 0, flipped: true });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    // 自己 network 仅 birmingham/dudley（自己的 Link #4）；tamworth 不可达
    withLink(s, 3, 0);
    setHand(s, 0, [indCard(['coal'], 'ind-coal-0')]);
    expect(buildsAt(enumerateBuilds(s, 0), 'tamworth').length).toBe(0);

    // Location 卡不要求 network → tamworth 覆盖合法；且执行的是覆盖而非占用空槽
    setHand(s, 0, [locCard('tamworth')]);
    expect(industriesAt(enumerateBuilds(s, 0), 'tamworth').has('coal')).toBe(true);
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-tamworth-test',
      industry: 'coal',
      location: 'tamworth',
    });
    expect(r.state.board.slots['tamworth']![0]!.player).toBe(0); // 对手矿被移出游戏
    expect(r.state.board.slots['tamworth']![0]!.tile.level).toBe(2);
    expect(r.state.board.slots['tamworth']![1]).toBeNull(); // 空槽未被动用
    expect(r.state.board.slots['tamworth']![0]!.resources).toBe(3); // 不连通商人位 → 不卖
    expect(r.state.players[0]!.money).toBe(17 - 7); // 煤 L2 £7、无煤耗
  });
});

describe('audit B: same industry & strictly higher level (①)', () => {
  it('own same-level overbuild is not enumerated; higher level is', () => {
    const s = newGame(4, 5);
    withTile(s, 0, 'worcester', 'cotton', { slot: 0, level: 1 });
    setHand(s, 0, [locCard('worcester')]);
    // 面板最低棉 = L1（同级）→ 不可覆盖；slot1 空槽但运河时代限 1 块
    expect(buildsAt(enumerateBuilds(s, 0), 'worcester').length).toBe(0);
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'cotton' || t.level >= 2);
    withLink(s, 28, 1); // #29 gloucester-worcester → 市场买煤连通（棉 L2 需 1 煤）
    expect(industriesAt(enumerateBuilds(s, 0), 'worcester').has('cotton')).toBe(true);
  });

  it('opponent same-level overbuild is not enumerated even with global cubes == 0', () => {
    const s = newGame(4, 5);
    s.coalMarket = 0;
    withTile(s, 1, 'dudley', 'coal', { slot: 0, level: 1, resources: 0, flipped: true });
    setHand(s, 0, [locCard('dudley')]);
    // 面板最低煤 = L1（与对手同级）→ 不可覆盖
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(false);
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(true); // L2 > L1
  });

  it('cross-industry overbuild is not enumerated (own and opponent)', () => {
    // 己方：cannock slot0 [manufacturer,coal] 被己 L1 煤矿占；制造 L2 等级够也不可跨产业
    const s = newGame(4, 5);
    withTile(s, 0, 'cannock', 'coal', { slot: 0 });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    s.players[0]!.money = 40;
    setHand(s, 0, [locCard('cannock')]);
    const inds = industriesAt(enumerateBuilds(s, 0), 'cannock');
    expect(inds.has('manufacturer')).toBe(false);
    expect(inds.has('coal')).toBe(true);

    // 对手：tamworth 两槽均为对手耗尽 L1 煤矿；棉 L2 等级够也不可跨产业盖煤矿
    const s2 = newGame(4, 5);
    s2.coalMarket = 0;
    withTile(s2, 1, 'tamworth', 'coal', { slot: 0, resources: 0, flipped: true });
    withTile(s2, 1, 'tamworth', 'coal', { slot: 1, resources: 0, flipped: true });
    s2.players[0]!.tiles = s2.players[0]!.tiles.filter(
      (t) => (t.industry === 'coal' ? t.level >= 2 : t.industry === 'cotton' ? t.level >= 2 : true),
    );
    withLink(s2, 7, 1); // #8 birmingham-tamworth
    withLink(s2, 5, 1); // #6 birmingham-oxford → 市场买煤连通（棉 L2 需 1 煤）
    s2.players[0]!.money = 40;
    setHand(s2, 0, [locCard('tamworth')]);
    const inds2 = industriesAt(enumerateBuilds(s2, 0), 'tamworth');
    expect(inds2.has('cotton')).toBe(false);
    expect(inds2.has('coal')).toBe(true);
  });
});

describe('audit B: overbuilt tile leaves the game; gains not revoked (④)', () => {
  it('overbuilt opponent tile is not scored at era end; opponent VP/income kept', () => {
    const s = newGame(4, 5);
    s.coalMarket = 0;
    // 对手 L1 煤矿已耗尽翻面（左下 1 VP 的时代末计分资格）
    withTile(s, 1, 'dudley', 'coal', { slot: 0, resources: 0, flipped: true });
    s.players[1]!.vp = 30; // 对手此前已获 VP
    s.players[1]!.incomeSpace = 14; // 翻面时已获收入
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    setHand(s, 0, [locCard('dudley')]);
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-dudley-test',
      industry: 'coal',
      location: 'dudley',
    });
    expect(r.state.players[1]!.vp).toBe(30); // ④ 已获 VP 不收回
    expect(r.state.players[1]!.incomeSpace).toBe(14); // ④ 已获收入不收回
    // 时代末翻面产业计分：被覆盖的矿已移出游戏 → 对手不得分；新矿未翻面也不得分
    const scored = scoreFlippedIndustries(r.state);
    expect(scored.players[1]!.vp).toBe(30);
    expect(scored.players[0]!.vp).toBe(0);
  });

  it('overbuilt own flipped tile will not score VPs ("return them to the box")', () => {
    const s = newGame(4, 5);
    // 自己已翻面 L1 棉厂（5 VP）；覆盖成 L2 后旧板块移出游戏
    withTile(s, 0, 'worcester', 'cotton', { slot: 0, level: 1, flipped: true, resources: 0 });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'cotton' || t.level >= 2);
    withLink(s, 28, 1); // #29 gloucester-worcester → 市场买煤连通
    setHand(s, 0, [locCard('worcester')]);
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-worcester-test',
      industry: 'cotton',
      location: 'worcester',
    });
    const t = r.state.board.slots['worcester']![0]!;
    expect(t.tile.level).toBe(2); // ⑥ 新板块进原槽位（slot0）
    expect(t.flipped).toBe(false);
    const scored = scoreFlippedIndustries(r.state);
    expect(scored.players[0]!.vp).toBe(0); // 旧板块 5 VP 不再计；新板块未翻面不计
  });
});

describe('audit B: global-cubes precondition — market alone blocks (③)', () => {
  it('opponent coal overbuild blocked when only the market holds coal cubes', () => {
    const s = newGame(4, 5);
    withTile(s, 1, 'dudley', 'coal', { slot: 0, resources: 0, flipped: true }); // 版图上无煤方块
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    setHand(s, 0, [locCard('dudley')]);
    expect(s.coalMarket).toBe(13); // 市场还有煤 → 不可覆盖
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(false);
    s.coalMarket = 0; // 市场也清空 → 全图煤归零 → 可覆盖
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(true);
  });
});

describe('audit B: no valid card → no overbuild (⑤)', () => {
  it('overbuild needs a matching card like normal build', () => {
    // 对手覆盖：手持无关 Location 卡（worcester）不能覆盖 dudley 的矿
    const s = newGame(4, 5);
    s.coalMarket = 0;
    withTile(s, 1, 'dudley', 'coal', { slot: 0, resources: 0, flipped: true });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    setHand(s, 0, [locCard('worcester', 'loc-worcester-0')]);
    expect(buildsAt(enumerateBuilds(s, 0), 'dudley').length).toBe(0);

    // 己方覆盖：手持无关 Industry 卡（iron）且无 network，不能覆盖 dudley 的己矿
    const s2 = newGame(4, 5);
    withTile(s2, 0, 'dudley', 'coal', { slot: 0 });
    s2.players[0]!.tiles = s2.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    withTile(s2, 0, 'coalbrookdale', 'iron', { slot: 1 }); // network 仅 coalbrookdale
    setHand(s2, 0, [indCard(['iron'], 'ind-iron-0')]);
    expect(buildsAt(enumerateBuilds(s2, 0), 'dudley').length).toBe(0);
  });
});

describe('audit B: canal-era one-tile-per-location interaction (⑦)', () => {
  it('canal era: own overbuild is a replacement — allowed despite the limit', () => {
    const s = newGame(4, 5);
    withTile(s, 0, 'birmingham', 'iron', { slot: 2 }); // 同地已有己方板块
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'iron' || t.level >= 2);
    withLink(s, 5, 1); // #6 birmingham-oxford → 市场买煤连通（铁 L2 需 1 煤）
    setHand(s, 0, [locCard('birmingham')]);
    const inds = industriesAt(enumerateBuilds(s, 0), 'birmingham');
    expect(inds.has('cotton')).toBe(false); // 新增第 2 块 → 禁止
    expect(inds.has('iron')).toBe(true); // 覆盖己方 = 替换 → 允许
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-birmingham-test',
      industry: 'iron',
      location: 'birmingham',
    });
    expect(r.state.board.slots['birmingham']![2]!.tile.level).toBe(2); // ⑥ 原槽位
    // 同地仍只有 1 块己方板块
    expect(r.state.board.slots['birmingham']!.filter((t) => t && t.player === 0).length).toBe(1);
  });

  it('canal era: opponent overbuild blocked if own tile already at that location; legal otherwise', () => {
    const s = newGame(4, 5);
    s.coalMarket = 0;
    withTile(s, 1, 'dudley', 'coal', { slot: 0, resources: 0, flipped: true }); // 对手耗尽矿
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'coal' || t.level >= 2);
    setHand(s, 0, [locCard('dudley')]);
    // 同地无己方板块 → 运河时代覆盖对手合法（覆盖后自己在此恰 1 块）
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(true);
    // 同地已有己方板块 → 覆盖对手会变成 2 块 → 禁止
    withTile(s, 0, 'dudley', 'iron', { slot: 1 });
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(false);
    // 铁路时代解除限制
    s.era = 'rail';
    expect(industriesAt(enumerateBuilds(s, 0), 'dudley').has('coal')).toBe(true);
  });
});
