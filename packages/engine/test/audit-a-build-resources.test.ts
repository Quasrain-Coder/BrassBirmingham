import { describe, expect, it } from 'vitest';
import { applyBuild, enumerateBuilds } from '../src/actions/build.js';
import { newGame, type GameState } from '../src/state.js';
import { LOCATIONS } from '../src/data/board.js';
import { tileDef } from '../src/data/tiles.js';
import type { Card } from '../src/data/cards.js';
import type { IndustryType, LocationId, PlayerIndex } from '../src/types.js';

// 审计域：Build 行动 —— 资源消耗（煤/铁）合规探针（规则书 p.8 Consuming Coal/Iron，
// rules-reference §5/§6.1/§9.1）。本文件全部为"应通过"的合规证据：
// ① 煤：连通最近未翻面煤矿免费取，不足部分从市场买（须连通商人图标）；
// ② 煤市场买空后 £8/块兜底；
// ③ 铁：任意未翻面铁厂免费取、可跨厂混源、无需连通；
// ④ 煤源按距离取最近者。

const locCard = (location: LocationId, id = `loc-${location}-audit`): Card => ({
  id,
  kind: 'location',
  location,
});

function setHand(s: GameState, player: PlayerIndex, cards: Card[]): void {
  s.players[player]!.hand = cards;
}

function findSlot(loc: LocationId, industry: IndustryType): number {
  const idx = LOCATIONS[loc]!.slots.findIndex((sd) => sd.industries.includes(industry));
  if (idx < 0) throw new Error(`no slot for ${industry} at ${loc}`);
  return idx;
}

function withTile(
  s: GameState,
  player: PlayerIndex,
  loc: LocationId,
  industry: IndustryType,
  opts: { level?: number; resources?: number } = {},
): void {
  const def = tileDef(industry, opts.level ?? 1)!;
  s.board.slots[loc]![findSlot(loc, industry)] = {
    tile: def,
    player,
    flipped: false,
    resources: opts.resources ?? def.resourcesPlaced,
  };
}

function withLink(s: GameState, linkIndex: number, player: PlayerIndex): void {
  s.board.links.push({ linkIndex, player, era: s.era });
}

describe('audit compliance: coal consumption (rulebook p.8 Consuming Coal)', () => {
  it('free coal from nearest connected mine first, remainder bought from market (merchant-connected)', () => {
    // 制造 L3 = £12 + 2 煤。对手的 stone 煤矿（1 块，距离 1）免费取 1 块并耗尽翻面
    // （对手进收入 +4）；余 1 块从市场买（stoke 经 #36 连通 warrington 商人位），最廉 £1。
    const s = newGame(4, 5);
    withLink(s, 35, 1); // #36 stoke-warrington（任何玩家的 Link 都算连通）
    withLink(s, 34, 1); // #35 stoke-stone
    withTile(s, 1, 'stone', 'coal', { resources: 1 });
    s.players[0]!.tiles = s.players[0]!.tiles.filter(
      (t) => t.industry !== 'manufacturer' || t.level >= 3,
    );
    setHand(s, 0, [locCard('stoke-on-trent')]);
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-stoke-on-trent-audit',
      industry: 'manufacturer',
      location: 'stoke-on-trent',
    });
    expect(r.state.board.slots['stoke-on-trent']![2]!.tile.level).toBe(3); // 单图标制造槽
    expect(r.state.board.slots['stone']![1]!.resources).toBe(0);
    expect(r.state.board.slots['stone']![1]!.flipped).toBe(true);
    expect(r.state.players[1]!.incomeSpace).toBe(14); // 对手矿耗尽翻面 +4
    expect(r.state.players[0]!.money).toBe(4); // 17 - 12 - 1(市场煤)
    expect(r.state.players[0]!.spentThisRound).toBe(13);
    expect(r.state.coalMarket).toBe(12); // 13 - 1
    expect(r.events).toEqual([{ kind: 'flip', player: 1, location: 'stone', incomeAdvance: 4 }]);
  });

  it('coal market empty → fallback £8 per cube (still requires merchant connection)', () => {
    const s = newGame(4, 5);
    s.coalMarket = 0;
    withLink(s, 35, 1); // #36 stoke-warrington
    s.players[0]!.money = 40;
    s.players[0]!.tiles = s.players[0]!.tiles.filter(
      (t) => t.industry !== 'manufacturer' || t.level >= 3,
    );
    setHand(s, 0, [locCard('stoke-on-trent')]);
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-stoke-on-trent-audit',
      industry: 'manufacturer',
      location: 'stoke-on-trent',
    });
    expect(r.state.players[0]!.money).toBe(12); // 40 - 12 - 2×8
    expect(r.state.players[0]!.spentThisRound).toBe(28);
    expect(r.state.coalMarket).toBe(0);
  });

  it('coal taken from the closest mine, not a farther one', () => {
    // 棉 L2 = £14 + 1 煤。dudley 矿距离 1（#26），coalbrookdale 矿距离 3（#26→#27→#22）。
    const s = newGame(4, 5);
    withLink(s, 25, 1); // #26 dudley-kidderminster
    withLink(s, 26, 1); // #27 dudley-wolverhampton
    withLink(s, 21, 1); // #22 coalbrookdale-wolverhampton
    withTile(s, 1, 'dudley', 'coal', { resources: 2 });
    withTile(s, 1, 'coalbrookdale', 'coal', { resources: 3 });
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t.industry !== 'cotton' || t.level >= 2);
    setHand(s, 0, [locCard('kidderminster')]);
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-kidderminster-audit',
      industry: 'cotton',
      location: 'kidderminster',
    });
    expect(r.state.board.slots['kidderminster']![1]!.tile.industry).toBe('cotton'); // 单图标棉槽优先
    expect(r.state.board.slots['dudley']![0]!.resources).toBe(1); // 最近矿取 1 块
    expect(r.state.board.slots['coalbrookdale']![2]!.resources).toBe(3); // 远矿不动
    expect(r.state.players[0]!.money).toBe(3); // 17 - 14，煤免费
    expect(r.events).toEqual([]);
  });
});

describe('audit compliance: iron consumption (rulebook p.8 Consuming Iron, §9.1)', () => {
  it('iron from any unflipped iron works, mixing across sources, no connectivity needed', () => {
    // 制造 L8 = £20 + 2 铁。两座不连通的铁厂（不同玩家）各 1 块 → 混源取尽、双双翻面。
    const s = newGame(4, 5);
    withTile(s, 1, 'coalbrookdale', 'iron', { resources: 1 });
    withTile(s, 2, 'dudley', 'iron', { resources: 1 });
    s.players[0]!.money = 40;
    s.players[0]!.tiles = s.players[0]!.tiles.filter(
      (t) => t.industry !== 'manufacturer' || t.level >= 8,
    );
    setHand(s, 0, [locCard('birmingham')]);
    // birmingham 无任何 Link —— 铁不需要连通，行动仍应合法
    const acts = enumerateBuilds(s, 0);
    expect(
      acts.some(
        (a) => a.type === 'build' && a.location === 'birmingham' && a.industry === 'manufacturer',
      ),
    ).toBe(true);
    const r = applyBuild(s, 0, {
      type: 'build',
      cardId: 'loc-birmingham-audit',
      industry: 'manufacturer',
      location: 'birmingham',
    });
    expect(r.state.players[0]!.money).toBe(20); // 40 - 20，铁免费
    expect(r.state.ironMarket).toBe(8); // 未动市场
    expect(r.state.players[1]!.incomeSpace).toBe(13); // 铁 L1 耗尽翻面 +3
    expect(r.state.players[2]!.incomeSpace).toBe(13);
    expect(r.events).toEqual([
      { kind: 'flip', player: 1, location: 'coalbrookdale', incomeAdvance: 3 },
      { kind: 'flip', player: 2, location: 'dudley', incomeAdvance: 3 },
    ]);
  });
});
