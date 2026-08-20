import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { enumerateNetwork, applyNetwork } from '../src/actions/network.js';
import { enumerateDevelop, applyDevelop } from '../src/actions/develop.js';
import { enumerateLoan, applyLoan } from '../src/actions/loan.js';
import { enumerateScout, applyScout } from '../src/actions/scout.js';
import { applyPass } from '../src/actions/pass.js';
import { IllegalActionError } from '../src/errors.js';
import { LINKS, LOCATIONS } from '../src/data/board.js';
import { BREWERY_BARRELS } from '../src/data/market.js';
import { tileDef } from '../src/data/tiles.js';
import type { Action, IndustryType, LocationId, PlayerIndex } from '../src/types.js';

type NetworkAction = Extract<Action, { type: 'network' }>;

// 辅助：给玩家一块板（直接改 state.board.slots，放到该产业首个匹配空槽）。
// 酿酒厂桶数按时代（BREWERY_BARRELS），其余按 TileDef.resourcesPlaced。
function withTile(
  state: GameState,
  player: PlayerIndex,
  location: LocationId,
  industry: IndustryType,
  level = 1,
): void {
  const def = tileDef(industry, level);
  if (!def) throw new Error('missing tile def');
  const slotDefs = LOCATIONS[location]!.slots;
  const slots = state.board.slots[location]!;
  const idx = slotDefs.findIndex((sd, i) => sd.industries.includes(industry) && slots[i] === null);
  if (idx < 0) throw new Error(`no empty slot for ${industry} at ${location}`);
  slots[idx] = {
    tile: def,
    player,
    flipped: false,
    resources: industry === 'brewery' ? BREWERY_BARRELS[state.era] : def.resourcesPlaced,
  };
}

describe('network', () => {
  it('canal link costs £3 and must be adjacent to own network', () => {
    const s = newGame(4, 3);
    withTile(s, 0, 'coventry', 'pottery');
    s.players[0]!.hand = [{ id: 'c1', kind: 'industry', industries: ['coal'] }];
    const nets = enumerateNetwork(s, 0);
    const links = nets.flatMap((a) => (a.type === 'network' ? a.links : []));
    // coventry 相邻边中运河时代可建的只有 birmingham-coventry（表内 #3 → 0 基下标 2）；
    // coventry-nuneaton（#23）是 rail-only，运河时代被时代过滤排除。
    expect(new Set(links)).toEqual(new Set([2]));
  });

  it('first network: with no tiles and no links any empty era link is available', () => {
    const s = newGame(4, 3);
    s.players[0]!.hand = [{ id: 'c1', kind: 'industry', industries: ['coal'] }];
    const nets = enumerateNetwork(s, 0);
    const links = new Set(nets.flatMap((a) => (a.type === 'network' ? a.links : [])));
    expect(links.size).toBe(LINKS.filter((l) => l.canal).length);
  });

  it('cannot build on an already-built edge; new link must touch own network', () => {
    const s = newGame(4, 3);
    withTile(s, 0, 'coventry', 'pottery');
    s.players[0]!.hand = [{ id: 'c1', kind: 'industry', industries: ['coal'] }];
    s.board.links.push({ linkIndex: 2, player: 1, era: 'canal' }); // 对手已建 birmingham-coventry
    const nets = enumerateNetwork(s, 0);
    const links = new Set(nets.flatMap((a) => (a.type === 'network' ? a.links : [])));
    expect(links.has(2)).toBe(false); // 同一条边只能 1 条 Link
    expect(links.has(3)).toBe(false); // birmingham-dudley 不与 {coventry} 相邻
  });

  it('rail era: double link costs £15 + 1 brewery beer, each link consumes 1 coal', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    withTile(s, 0, 'coventry', 'pottery');
    withTile(s, 0, 'derby', 'brewery', 2); // 自己的酒厂供啤酒（铁路时代 2 桶）；derby 边连通商人位供买煤
    s.players[0]!.money = 30;
    const nets = enumerateNetwork(s, 0);
    const doubles = nets.filter((a) => a.type === 'network' && a.links.length === 2);
    expect(doubles.length).toBeGreaterThan(0);
    const after = applyNetwork(s, 0, doubles[0]!);
    // 场上无煤矿 → 2 条铁路的 2 块煤走市场：£1 + £2 = £3（初始市场 £1 格只有 1 块）
    expect(after.players[0]!.money).toBe(30 - 15 - 3);
    expect(after.players[0]!.spentThisRound).toBe(15 + 3);
    expect(after.board.links).toHaveLength(2);
    // 啤酒来自自己的酒厂（2 桶喝 1，不翻面）
    const brewery = after.board.slots['derby']!.find((t) => t !== null)!;
    expect(brewery.resources).toBe(1);
    expect(brewery.flipped).toBe(false);
  });

  it('rail single link costs £5 plus 1 coal', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    withTile(s, 0, 'coventry', 'pottery');
    withTile(s, 0, 'derby', 'brewery', 2); // derby-nottingham 边使市场买煤连通
    s.players[0]!.money = 30;
    const nets = enumerateNetwork(s, 0);
    const single = nets.find((a) => a.type === 'network' && a.links.length === 1)!;
    const after = applyNetwork(s, 0, single);
    // 单条 £5 + 1 煤（无煤矿 → 市场 £1；锚点为该条铁路放置后的端点）
    expect(after.players[0]!.money).toBe(30 - 5 - 1);
    expect(after.players[0]!.spentThisRound).toBe(5 + 1);
    expect(after.board.links).toHaveLength(1);
  });

  it('double-link beer cannot come from merchant beer', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    withTile(s, 0, 'coventry', 'pottery');
    s.players[0]!.money = 30;
    // 前置：场上确有商人啤酒可用（开局非 blank 商人板块带桶）
    expect(Object.values(s.merchants).some((m) => m.beer > 0)).toBe(true);
    // 只有商人啤酒可用、无酒厂 → 不枚举任何双轨行动
    const nets = enumerateNetwork(s, 0);
    expect(nets.some((a) => a.type === 'network' && a.links.length === 2)).toBe(false);
  });

  it('double rail link requires £15', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    withTile(s, 0, 'coventry', 'pottery');
    withTile(s, 0, 'derby', 'brewery', 2);
    s.players[0]!.money = 14;
    const nets = enumerateNetwork(s, 0);
    expect(nets.some((a) => a.type === 'network' && a.links.length === 2)).toBe(false);
  });

  it('double link beer may come from an opponent brewery connected to the second link', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    withTile(s, 0, 'coventry', 'coal'); // 煤矿（2 块）供两条铁路的煤
    withTile(s, 1, 'nuneaton', 'brewery', 1); // 对手酒厂（铁路时代 2 桶）
    s.players[0]!.money = 30;
    const nets = enumerateNetwork(s, 0);
    // 双轨 [birmingham-coventry(2), coventry-nuneaton(22)]：第二条使 nuneaton 连通
    const dbl = nets.find(
      (a): a is NetworkAction =>
        a.type === 'network' && a.links.length === 2 && a.links.includes(22),
    )!;
    expect(dbl).toBeDefined();
    const after = applyNetwork(s, 0, { ...dbl, beerFromOpponentBrewery: 'nuneaton' });
    const brewery = after.board.slots['nuneaton']!.find(
      (t) => t !== null && t.tile.industry === 'brewery',
    )!;
    expect(brewery.resources).toBe(1);
  });

  it('double link beer pin rejects an opponent brewery not connected to the second link', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    withTile(s, 0, 'coventry', 'coal');
    withTile(s, 1, 'burton-on-trent', 'brewery', 1); // 不连通第二条铁路的对手酒厂
    s.players[0]!.money = 30;
    const nets = enumerateNetwork(s, 0);
    const dbl = nets.find(
      (a): a is NetworkAction =>
        a.type === 'network' && a.links.length === 2 && a.links.includes(22),
    )!;
    expect(() =>
      applyNetwork(s, 0, { ...dbl, beerFromOpponentBrewery: 'burton-on-trent' }),
    ).toThrowError(IllegalActionError);
  });

  it('double rail coal is settled serially: market price steps to fallback after first buy', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    withTile(s, 0, 'derby', 'brewery', 2); // 啤酒 + derby-nottingham 边连通市场
    s.coalMarket = 1; // 仅 1 块煤：filled 块占最贵格 → £7，买空后兜底 £8
    s.players[0]!.money = 30; // £15 + £7 + £8 恰好够
    const nets = enumerateNetwork(s, 0);
    const doubles = nets.filter((a) => a.type === 'network' && a.links.length === 2);
    expect(doubles.length).toBeGreaterThan(0);
    const after = applyNetwork(s, 0, doubles[0]!);
    expect(after.players[0]!.money).toBe(30 - 15 - 7 - 8);

    // 现金够 £15+£7 买第一块、但第二块付不起真实 £8 兜底 → 不枚举双轨
    const poor = newGame(4, 3);
    poor.era = 'rail';
    withTile(poor, 0, 'derby', 'brewery', 2);
    poor.coalMarket = 1;
    poor.players[0]!.money = 23;
    expect(
      enumerateNetwork(poor, 0).some((a) => a.type === 'network' && a.links.length === 2),
    ).toBe(false);
  });

  it('double rail coal is settled serially: a 1-cube mine cannot feed both links', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    withTile(s, 0, 'coventry', 'coal');
    withTile(s, 0, 'burton-on-trent', 'brewery', 2); // 啤酒（自己的酒厂全图可用）
    s.board.slots['coventry']!.find((t) => t !== null)!.resources = 1; // 连通矿仅 1 块煤
    s.players[0]!.money = 30;
    const nets = enumerateNetwork(s, 0);
    const has = (x: number, y: number): boolean =>
      nets.some(
        (a) =>
          a.type === 'network' &&
          a.links.length === 2 &&
          a.links.includes(x) &&
          a.links.includes(y),
      );
    // [birmingham-coventry(2), coventry-nuneaton(22)] 都想吃这 1 块免费煤且无市场连通 → 不枚举
    expect(has(2, 22)).toBe(false);
    // 第二条改走市场（birmingham-oxford(5) 连通商人位）且付得起 → 枚举
    expect(has(2, 5)).toBe(true);
  });
});

describe('develop', () => {
  it('develop removes 1-2 lowest-level tiles, 1 iron each; lightbulb pottery not removable', () => {
    const s = newGame(4, 3);
    const devs = enumerateDevelop(s, 0);
    // 开局面板最低级：每产业 level 1；pottery 1 是灯泡 → 不在 removals 候选
    const removals = devs.flatMap((a) => (a.type === 'develop' ? a.removals : []));
    expect(removals).not.toContain('pottery');
    expect(removals).toContain('cotton');
  });

  it('applyDevelop removes 2 tiles sequentially and pays 1 iron each (market £2+£2)', () => {
    const s = newGame(4, 3);
    const devs = enumerateDevelop(s, 0);
    const two = devs.find((a) => a.type === 'develop' && a.removals.length === 2)!;
    const after = applyDevelop(s, 0, two);
    expect(after.players[0]!.tiles).toHaveLength(s.players[0]!.tiles.length - 2);
    // 场上无铁厂 → 2 块铁走市场：£2 + £2 = £4（初始市场 2 个 £1 格空，最便宜已填格 £2）
    expect(after.players[0]!.money).toBe(17 - 4);
    expect(after.players[0]!.spentThisRound).toBe(4);
  });

  it('second removal re-evaluates the lowest level (same industry twice allowed)', () => {
    const s = newGame(4, 3);
    const devs = enumerateDevelop(s, 0);
    const sameIndustry = devs.find(
      (a) => a.type === 'develop' && a.removals.length === 2 && a.removals[0] === a.removals[1],
    )!;
    expect(sameIndustry).toBeDefined();
    const after = applyDevelop(s, 0, sameIndustry);
    const ind = (sameIndustry as Extract<typeof sameIndustry, { type: 'develop' }>).removals[0]!;
    expect(after.players[0]!.tiles.filter((t) => t.industry === ind)).toHaveLength(
      s.players[0]!.tiles.filter((t) => t.industry === ind).length - 2,
    );
  });

  it('applyDevelop rejects an action outside the enumerated set', () => {
    const s = newGame(4, 3);
    const cardId = s.players[0]!.hand[0]!.id;
    expect(() => applyDevelop(s, 0, { type: 'develop', cardId, removals: ['pottery'] })).toThrowError(
      IllegalActionError,
    );
  });
});

describe('loan', () => {
  it('loan: +£30, back 3 income LEVELS landing on highest space', () => {
    const s = newGame(4, 3);
    const after = applyLoan(s, 0, { type: 'loan', cardId: s.players[0]!.hand[0]!.id });
    expect(after.players[0]!.money).toBe(47);
    expect(after.players[0]!.incomeSpace).toBe(7); // level 0 → level -3
  });

  it('loan forbidden at income level -10', () => {
    const s = newGame(4, 3);
    s.players[0]!.incomeSpace = 0;
    expect(enumerateLoan(s, 0)).toHaveLength(0);
    expect(() =>
      applyLoan(s, 0, { type: 'loan', cardId: s.players[0]!.hand[0]!.id }),
    ).toThrowError(IllegalActionError);
  });

  it('loan forbidden when backtracking 3 levels would go below -10 (level -8)', () => {
    const s = newGame(4, 3);
    s.players[0]!.incomeSpace = 2; // level -8：退 3 级会破 −10 底
    expect(enumerateLoan(s, 0)).toHaveLength(0);
    expect(() =>
      applyLoan(s, 0, { type: 'loan', cardId: s.players[0]!.hand[0]!.id }),
    ).toThrowError(IllegalActionError);
  });

  it('loan at level -7 is allowed and lands on level -10', () => {
    const s = newGame(4, 3);
    s.players[0]!.incomeSpace = 3; // level -7
    expect(enumerateLoan(s, 0).length).toBeGreaterThan(0);
    const after = applyLoan(s, 0, { type: 'loan', cardId: s.players[0]!.hand[0]!.id });
    expect(after.players[0]!.incomeSpace).toBe(0); // level -10 最高格
    expect(after.players[0]!.money).toBe(47);
  });
});

describe('scout', () => {
  it('scout enumerates all 3-card discard combos (C(8,3)=56), grants both wilds; forbidden while holding a wild', () => {
    const s = newGame(4, 3);
    // 弃哪 3 张有策略意义（甩废卡），不做组合规范化
    expect(enumerateScout(s, 0)).toHaveLength(56);
    const real = s.players[0]!.hand.slice(0, 3).map((c) => c.id) as [string, string, string];
    const after = applyScout(s, 0, { type: 'scout', cardIds: real });
    expect(after.players[0]!.hand.filter((c) => c.kind.startsWith('wild'))).toHaveLength(2);
    expect(enumerateScout(after, 0)).toHaveLength(0);
  });

  it('applyScout moves the 3 discards to the discard pile and drains the wild supply', () => {
    const s = newGame(4, 3);
    const real = s.players[0]!.hand.slice(0, 3).map((c) => c.id) as [string, string, string];
    const after = applyScout(s, 0, { type: 'scout', cardIds: real });
    expect(after.discard).toHaveLength(s.discard.length + 3);
    expect(after.wildSupply).toEqual({ location: 3, industry: 3 });
    expect(after.players[0]!.hand).toHaveLength(7);
  });

  it('scout forbidden when a wild supply is empty', () => {
    const s = newGame(4, 3);
    s.wildSupply = { location: 0, industry: 2 };
    expect(enumerateScout(s, 0)).toHaveLength(0);
  });
});

describe('pass', () => {
  it('applyPass is a no-op on state; rejects a card not in hand', () => {
    const s = newGame(4, 3);
    const after = applyPass(s, 0, { type: 'pass', cardId: s.players[0]!.hand[0]!.id });
    expect(after.players[0]).toEqual(s.players[0]);
    expect(() => applyPass(s, 0, { type: 'pass', cardId: 'nope' })).toThrowError(
      IllegalActionError,
    );
  });
});
