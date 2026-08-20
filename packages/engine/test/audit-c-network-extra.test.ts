/**
 * 审计域 C 补充：Network 铺路（规则书 p.11 [txt 1344-1364]；rules-reference §6.3/§9.4）。
 * 覆盖 audit-c-network.test.ts 未触及的四个场景：
 *  A. 双轨啤酒不可来自商人啤酒（场上无任何酒厂时，即使商人位有桶也不枚举双轨）。
 *  B. 对手酒厂只连通"第一条"铁路（不连通第二条）→ 该放置顺序的双轨不合法；
 *     反序（酒厂连通第二条，放置后判定）→ 合法。
 *  C. 市场煤买空后按 £8/块兜底（仍须连通商人位图标）。
 *  D. 显式指定不连通的对手酒厂（beerFromOpponentBrewery）→ apply 拒绝；
 *     同一行动走默认来源则成功且喝自家酒厂。
 * 只读审计：不修改 src。
 */
import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { enumerateNetwork, applyNetwork } from '../src/actions/network.js';
import { IllegalActionError } from '../src/errors.js';
import { LOCATIONS } from '../src/data/board.js';
import { BREWERY_BARRELS } from '../src/data/market.js';
import { tileDef } from '../src/data/tiles.js';
import type { Action, IndustryType, LocationId, PlayerIndex } from '../src/types.js';

type NetworkAction = Extract<Action, { type: 'network' }>;

// —— 辅助（与 audit-c-network.test.ts 同款）：直接改 board 构造局面 ——
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

describe('A. 双轨啤酒不可来自商人啤酒 [R p.11 "must be consumed from a Brewery (not a Merchant beer)"]', () => {
  it('场上无任何酒厂、只有商人啤酒 → 不枚举任何双轨，单轨照常', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    withTile(s, 1, 'coventry', 'coal'); // 对手矿 2 块：单/双轨煤源都不缺
    s.players[0]!.money = 30;
    oneCard(s, 0);
    // 前提：商人位确有啤酒（否则本测试无意义），且全场无酒厂
    const merchantBeer = Object.values(s.merchants).reduce((sum, m) => sum + m.beer, 0);
    expect(merchantBeer).toBeGreaterThan(0);
    const actions = enumerateNetwork(s, 0);
    expect(actions.some((a) => a.type === 'network')).toBe(true); // 单轨合法
    expect(actions.every((a) => a.type === 'network' && a.links.length === 1)).toBe(true); // 双轨一律不枚举
  });
});

describe('B. 对手酒厂须连通"第二条"铁路（放置后），而非第一条 [R p.11 Remember]', () => {
  function setup(): GameState {
    const s = newGame(4, 7);
    s.era = 'rail';
    // 两段互不相连的 network 锚点
    withTile(s, 0, 'wolverhampton', 'manufacturer'); // 锚点甲
    withTile(s, 0, 'stoke-on-trent', 'manufacturer'); // 锚点乙
    withTile(s, 1, 'wolverhampton', 'coal'); // 对手矿 2 块（供 #22）
    withTile(s, 1, 'stone', 'coal'); // 对手矿 2 块（供 #35）
    withTile(s, 1, 'coalbrookdale', 'brewery'); // 对手酒厂 2 桶：只连通 wolverhampton 一侧
    s.players[0]!.money = 30;
    oneCard(s, 0);
    return s;
  }
  // idx 21 = #22 coalbrookdale-wolverhampton；idx 34 = #35 stoke-on-trent-stone

  it('先铺连通酒厂的一侧、再铺另一侧：酒厂不连通第二条 → 不枚举', () => {
    const s = setup();
    expect(findDouble(s, 0, 21, 34)).toBeUndefined();
  });

  it('反序：酒厂连通第二条（放置后）→ 枚举且喝对手的酒', () => {
    const s = setup();
    const dbl = findDouble(s, 0, 34, 21);
    expect(dbl).toBeDefined();
    const after = applyNetwork(s, 0, dbl!);
    expect(after.players[0]!.money).toBe(30 - 15); // 两块煤全免费
    const brewery = after.board.slots['coalbrookdale']!.find(
      (t) => t !== null && t.tile.industry === 'brewery',
    )!;
    expect(brewery.resources).toBe(1); // 对手酒厂被喝 1 桶
    expect(after.board.slots['stone']![1]!.resources).toBe(1);
    expect(after.board.slots['wolverhampton']![1]!.resources).toBe(1);
  });
});

describe('C. 市场煤买空后 £8/块兜底（仍须连通商人位）[R p.8；rules-reference §5]', () => {
  it('首建铁路连通商人位、市场为空 → 煤按 £8 计', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    s.coalMarket = 0; // 市场买空
    s.players[0]!.money = 30;
    oneCard(s, 0);
    // idx 23 = #24 derby-nottingham：放置后连通商人位 nottingham → 可按兜底价买煤
    const after = applyNetwork(s, 0, { type: 'network', cardId: 'audit-card', links: [23] });
    expect(after.players[0]!.money).toBe(30 - 5 - 8); // £5 路 + £8 兜底煤
    expect(after.players[0]!.spentThisRound).toBe(13);
    expect(after.coalMarket).toBe(0);
  });
});

describe('D. 显式指定对手酒厂为啤酒来源时的连通校验（apply 层）', () => {
  it('指定的对手酒厂不连通第二条铁路 → illegal；同行动默认来源成功且喝自家酒厂', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    withTile(s, 0, 'birmingham', 'iron'); // network 锚点
    withTile(s, 1, 'coventry', 'coal'); // 对手矿 2 块，供两条铁路
    withTile(s, 0, 'uttoxeter', 'brewery'); // 自家酒厂 2 桶（默认来源，无需连通）
    withTile(s, 1, 'burton-on-trent', 'brewery'); // 对手酒厂 2 桶，与双轨一侧均不连通
    s.players[0]!.money = 30;
    const cardId = oneCard(s, 0);
    // idx 2 = #3 birmingham-coventry；idx 22 = #23 coventry-nuneaton（枚举内合法双轨）
    const dbl = findDouble(s, 0, 2, 22);
    expect(dbl).toBeDefined();

    // 显式 pin 不连通的对手酒厂 → 拒绝
    expect(() =>
      applyNetwork(s, 0, { ...dbl!, beerFromOpponentBrewery: 'burton-on-trent' }),
    ).toThrowError(IllegalActionError);

    // 默认来源 → 成功，喝自家酒厂，对手酒厂原封不动
    const after = applyNetwork(s, 0, dbl!);
    const own = after.board.slots['uttoxeter']!.find((t) => t !== null)!;
    const opp = after.board.slots['burton-on-trent']!.find((t) => t !== null)!;
    expect(own.resources).toBe(1);
    expect(opp.resources).toBe(2);
  });
});
