/**
 * 审计域 C：Network 铺路（规则书 p.11 [txt 1312-1364]、p.8 "Your Network"/耗煤/耗酒、
 * p.9 Farm Breweries、p.12 network 图示；rules-reference §1.2/§6.3/§9.2/§9.4）。
 * 只读审计：不修改 src；每条断言对应规则清单 ①-⑦。
 */
import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { enumerateNetwork, applyNetwork } from '../src/actions/network.js';
import { isConnected, playerNetwork } from '../src/network.js';
import { IllegalActionError } from '../src/errors.js';
import { LOCATIONS } from '../src/data/board.js';
import { BREWERY_BARRELS } from '../src/data/market.js';
import { tileDef } from '../src/data/tiles.js';
import type { Action, IndustryType, LocationId, PlayerIndex } from '../src/types.js';

type NetworkAction = Extract<Action, { type: 'network' }>;

// —— 辅助（与 actions.test.ts 同款）：直接改 board 构造局面 ——
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

function oneCard(state: GameState, player: PlayerIndex): string {
  state.players[player]!.hand = [{ id: 'audit-card', kind: 'industry', industries: ['coal'] }];
  return 'audit-card';
}

/** 枚举出的所有单条 Link 下标集合（去重、跨手牌）。 */
function singleLinkSet(state: GameState, player: PlayerIndex): Set<number> {
  return new Set(
    enumerateNetwork(state, player).flatMap((a) =>
      a.type === 'network' && a.links.length === 1 ? a.links : [],
    ),
  );
}

function findDouble(
  state: GameState,
  player: PlayerIndex,
  first: number,
  second: number,
): NetworkAction | undefined {
  return enumerateNetwork(state, player).find(
    (a): a is NetworkAction =>
      a.type === 'network' &&
      a.links.length === 2 &&
      a.links[0] === first &&
      a.links[1] === second,
  );
}

describe('① 邻接：新 Link 必须与己方 network 相邻', () => {
  it('worcester 有板块时，运河时代候选恰为 3 条相邻运河边', () => {
    const s = newGame(4, 7);
    withTile(s, 0, 'worcester', 'cotton');
    oneCard(s, 0);
    // #10 birmingham-worcester(9)、#29 gloucester-worcester(28)、#30 kidderminster-worcester(29)
    expect(singleLinkSet(s, 0)).toEqual(new Set([9, 28, 29]));
  });

  it('己方 Link 的商人位端点也计入 network（birmingham-oxford → 可铺 redditch-oxford）', () => {
    const s = newGame(4, 7);
    s.board.links.push({ linkIndex: 5, player: 0, era: s.era }); // #6 birmingham-oxford（自己）
    oneCard(s, 0);
    expect(playerNetwork(s, 0).has('oxford')).toBe(true);
    const links = singleLinkSet(s, 0);
    expect(links.has(32)).toBe(true); // #33 redditch-oxford 经商人位端点相邻
    // birmingham 侧运河边 #3(2)/#4(3)/#8(7)/#9(8)/#10(9)（#6 已被自己占用，#5/#7 rail-only）+ oxford 侧 #33(32)
    expect(links).toEqual(new Set([2, 3, 7, 8, 9, 32]));
  });

  it('非相邻的线在 apply 层同样拒绝（illegal-network）', () => {
    const s = newGame(4, 7);
    withTile(s, 0, 'worcester', 'cotton');
    const cardId = oneCard(s, 0);
    expect(() => applyNetwork(s, 0, { type: 'network', cardId, links: [0] })).toThrowError(
      IllegalActionError,
    ); // #1 belper-derby 与 {worcester} 不相邻
  });

  it('Cannock-北部农场：单条 Link #17 连接农场（候选含 idx 16）', () => {
    const s = newGame(4, 7);
    withTile(s, 0, 'cannock', 'coal');
    oneCard(s, 0);
    const links = singleLinkSet(s, 0);
    // 相邻运河边：#16 cannock-stafford(15)、#17 cannock-farm-north(16)、
    // #18 cannock-walsall(17)、#19 cannock-wolverhampton(18)；#11 是 rail-only
    expect(links).toEqual(new Set([15, 16, 17, 18]));
  });

  it('Kidderminster-Worcester Link #30 同时连接南农场，且该线只能放 1 条', () => {
    const s = newGame(4, 7);
    s.board.links.push({ linkIndex: 29, player: 0, era: s.era }); // #30（自己）
    oneCard(s, 0);
    // 三端点连通：两镇与 farm-south 互相连通
    expect(playerNetwork(s, 0).has('farm-south')).toBe(true);
    expect(isConnected(s, 0, 'farm-south')).toBe(true);
    // 候选 = 三端点的其余邻边；idx 29 已被自己占用 → 不能再放第 2 条
    expect(singleLinkSet(s, 0)).toEqual(new Set([9, 19, 25, 28]));
  });
});

describe('② 首建特例：无板块无 Link 可放任意空线（铁路仍须耗煤）', () => {
  it('运河时代首建：全部运河边可放（31 条）', () => {
    const s = newGame(4, 7);
    oneCard(s, 0);
    expect(singleLinkSet(s, 0).size).toBe(31); // 39 边 - 8 条 rail-only
  });

  it('铁路时代首建：任意铁路边可放，但仍须各自解决 1 煤', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    withTile(s, 1, 'dudley', 'coal'); // 对手煤矿 2 块（唯一免费煤源）
    s.players[0]!.money = 30;
    oneCard(s, 0);
    const links = singleLinkSet(s, 0);
    expect(links.has(3)).toBe(true); // #4 birmingham-dudley：放置后连通 dudley 矿 → 免费煤
    expect(links.has(23)).toBe(true); // #24 derby-nottingham：连通商人位 → 市场买煤
    expect(links.has(5)).toBe(true); // #6 birmingham-oxford：连通商人位 → 市场买煤
    expect(links.has(0)).toBe(false); // #1 belper-derby：无煤源且无商人连通 → 不能建
    expect(links.has(14)).toBe(false); // #15 canal-only：铁路时代一律不可建

    // 免费煤：只付 £5，矿少 1 块
    const after = applyNetwork(s, 0, { type: 'network', cardId: 'audit-card', links: [3] });
    expect(after.players[0]!.money).toBe(25);
    expect(after.board.slots['dudley']![0]!.resources).toBe(1);

    // 市场煤：£5 + £1（市场 cheapest），市场少 1 块
    const s2 = newGame(4, 7);
    s2.era = 'rail';
    withTile(s2, 1, 'dudley', 'coal');
    s2.players[0]!.money = 30;
    oneCard(s2, 0);
    const before = s2.coalMarket;
    const after2 = applyNetwork(s2, 0, { type: 'network', cardId: 'audit-card', links: [23] });
    expect(after2.players[0]!.money).toBe(24);
    expect(after2.coalMarket).toBe(before - 1);
  });

  it('首建双轨：第二条可链式相邻第一条，对手酒厂经第二条铁路连通供酒', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    withTile(s, 1, 'coventry', 'coal'); // 对手矿 2 块：两条铁路各 1
    withTile(s, 1, 'walsall', 'brewery'); // 对手酒厂 2 桶，仅经第二条 #9 连通
    s.players[0]!.money = 30;
    oneCard(s, 0);
    // 首建特例：第一条可放任意铁路边；第二条相邻第一条（放置后）即可
    const dbl = findDouble(s, 0, 2, 8); // birmingham-coventry → birmingham-walsall
    expect(dbl).toBeDefined();
    expect(findDouble(s, 0, 2, 2)).toBeUndefined(); // 同一条边不能放两条
    const after = applyNetwork(s, 0, dbl!);
    expect(after.players[0]!.money).toBe(30 - 15); // 两块免费煤
    const brewery = after.board.slots['walsall']!.find(
      (t) => t !== null && t.tile.industry === 'brewery',
    )!;
    expect(brewery.resources).toBe(1); // 对手酒厂（经第二条 #9 连通）供酒
  });
});

describe('③ 运河时代：只能运河 Link、每次 1 条、£3、不耗煤', () => {
  it('walsall 板块：候选含 canal-only #15(idx 14)、排除 rail-only #38(idx 37)', () => {
    const s = newGame(4, 7);
    withTile(s, 0, 'walsall', 'iron');
    oneCard(s, 0);
    // #9(8)、#15(14)、#18(17)、#39(38) 可建；#38 tamworth-walsall(37) rail-only 排除
    expect(singleLinkSet(s, 0)).toEqual(new Set([8, 14, 17, 38]));
  });

  it('运河 Link £3 且不耗煤（相邻煤矿不少块）', () => {
    const s = newGame(4, 7);
    withTile(s, 0, 'walsall', 'iron');
    withTile(s, 1, 'cannock', 'coal'); // 相邻对手煤矿 2 块
    oneCard(s, 0);
    const after = applyNetwork(s, 0, { type: 'network', cardId: 'audit-card', links: [17] });
    expect(after.players[0]!.money).toBe(17 - 3);
    expect(after.players[0]!.spentThisRound).toBe(3);
    expect(after.board.slots['cannock']![0]!.resources).toBe(2); // 运河不耗煤
    expect(after.board.links).toHaveLength(1);
  });

  it('运河时代不枚举双条，apply 双条也拒绝', () => {
    const s = newGame(4, 7);
    withTile(s, 0, 'walsall', 'iron');
    const cardId = oneCard(s, 0);
    expect(
      enumerateNetwork(s, 0).some((a) => a.type === 'network' && a.links.length === 2),
    ).toBe(false);
    expect(() => applyNetwork(s, 0, { type: 'network', cardId, links: [8, 17] })).toThrowError(
      IllegalActionError,
    );
  });
});

describe('④ 铁路时代：只能铁路 Link；1 条 £5 / 2 条 £15+1 啤酒', () => {
  it('canal-only #15 在铁路时代不可建（其余相邻铁路边按煤源判定）', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    withTile(s, 0, 'walsall', 'iron'); // network 锚点
    withTile(s, 0, 'wolverhampton', 'coal'); // 自己的煤矿：仅经 #39(idx 38) 连通
    s.players[0]!.money = 30;
    oneCard(s, 0);
    const links = singleLinkSet(s, 0);
    // network = {walsall(铁厂), wolverhampton(自家煤矿)}：wolverhampton 的三条邻边
    // #19(18)/#22(21)/#27(26) 与 #39(38) 均可建（放置后连通自家矿 → 免费煤）。
    // canal-only #15(14) 被时代过滤；#9(8)/#18(17)/#38(37) 虽相邻 walsall 但无煤源且无商人连通 → 排除。
    expect(links.has(14)).toBe(false);
    expect(links).toEqual(new Set([18, 21, 26, 38]));
  });

  it('双条 £15 + 啤酒，单条 £5 无啤酒；啤酒喝自酒厂', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    withTile(s, 0, 'coventry', 'coal'); // 2 块煤供两条铁路
    withTile(s, 0, 'uttoxeter', 'brewery'); // 自己的酒厂（铁路时代 2 桶），完全不连通也可用
    s.players[0]!.money = 30;
    oneCard(s, 0);
    const dbl = findDouble(s, 0, 2, 22); // birmingham-coventry → coventry-nuneaton
    expect(dbl).toBeDefined();
    const merchantBeerBefore = Object.values(s.merchants).map((m) => m.beer);
    const after = applyNetwork(s, 0, dbl!);
    expect(after.players[0]!.money).toBe(30 - 15); // 两块免费煤，无市场花费
    const brewery = after.board.slots['uttoxeter']!.find((t) => t !== null)!;
    expect(brewery.resources).toBe(1); // 喝 1 桶
    expect(brewery.flipped).toBe(false);
    // 商人啤酒原封不动（双轨不可用商人啤酒）
    expect(Object.values(after.merchants).map((m) => m.beer)).toEqual(merchantBeerBefore);
  });
});

describe('⑤ 双轨啤酒：必须来自酒厂；对手酒厂须连通第二条铁路（放置后）', () => {
  it('唯一啤酒来源是不连通的对手酒厂 → 不枚举任何双轨', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    withTile(s, 0, 'coventry', 'coal'); // 煤够
    withTile(s, 1, 'uttoxeter', 'brewery'); // 对手酒厂，与 coventry 一带完全不连通
    s.players[0]!.money = 30;
    oneCard(s, 0);
    expect(
      enumerateNetwork(s, 0).some((a) => a.type === 'network' && a.links.length === 2),
    ).toBe(false);
  });

  it('对手酒厂经第二条铁路（放置后）连通 → 双轨成立并喝对手的酒', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    withTile(s, 0, 'coventry', 'coal'); // 2 块煤
    withTile(s, 1, 'nuneaton', 'brewery'); // 对手酒厂，仅经第二条 #23 连通
    s.players[0]!.money = 30;
    oneCard(s, 0);
    const dbl = findDouble(s, 0, 2, 22);
    expect(dbl).toBeDefined();
    const after = applyNetwork(s, 0, dbl!);
    const brewery = after.board.slots['nuneaton']!.find(
      (t) => t !== null && t.tile.industry === 'brewery',
    )!;
    expect(brewery.resources).toBe(1); // 对手酒厂被喝 1 桶（规范化默认来源：无自家酒厂时取连通对手酒厂）
  });
});

describe('⑥ 每条铁路各耗 1 煤，逐条放置逐条判定', () => {
  it('第二条铁路可经"自身放置后"新连通的煤矿取煤（串行判定）', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    withTile(s, 0, 'birmingham', 'iron'); // network 锚点
    withTile(s, 1, 'dudley', 'coal'); // 对手矿，仅 1 块
    withTile(s, 1, 'kidderminster', 'coal'); // 对手矿，仅 1 块；仅经第二条 #26 连通
    s.board.slots['dudley']![0]!.resources = 1;
    s.board.slots['kidderminster']![0]!.resources = 1;
    withTile(s, 0, 'uttoxeter', 'brewery'); // 自家啤酒
    s.players[0]!.money = 30;
    oneCard(s, 0);
    // 无商人连通（市场不可用）：若引擎不是"放置第二条后再判煤"，第二块煤无来源 → 不枚举
    const dbl = findDouble(s, 0, 3, 25); // birmingham-dudley → dudley-kidderminster
    expect(dbl).toBeDefined();
    // 反向顺序不合法：第一条 #26 不与原 network {birmingham} 相邻
    expect(findDouble(s, 0, 25, 3)).toBeUndefined();

    const after = applyNetwork(s, 0, dbl!);
    expect(after.players[0]!.money).toBe(30 - 15); // 两块煤全免费
    expect(after.board.slots['dudley']![0]!.resources).toBe(0);
    expect(after.board.slots['dudley']![0]!.flipped).toBe(true); // 耗尽即翻面（对手进收入）
    expect(after.board.slots['kidderminster']![0]!.resources).toBe(0);
    expect(after.board.slots['kidderminster']![0]!.flipped).toBe(true);
  });
});

describe('⑦ 占用线不可再放', () => {
  it('对手已占的相邻线不枚举、apply 拒绝', () => {
    const s = newGame(4, 7);
    withTile(s, 0, 'worcester', 'cotton');
    s.board.links.push({ linkIndex: 28, player: 1, era: s.era }); // 对手占了 #29 gloucester-worcester
    const cardId = oneCard(s, 0);
    expect(singleLinkSet(s, 0)).toEqual(new Set([9, 29]));
    expect(() => applyNetwork(s, 0, { type: 'network', cardId, links: [28] })).toThrowError(
      IllegalActionError,
    );
  });
});
