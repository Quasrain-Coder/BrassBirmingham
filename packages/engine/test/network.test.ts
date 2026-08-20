import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { tileDef } from '../src/data/tiles.js';
import type { LocationId, PlayerIndex } from '../src/types.js';
import {
  canBuyCoalFromMarket,
  coalSources,
  connectedMerchants,
  ironSources,
  isConnected,
  playerNetwork,
} from '../src/network.js';

/** 手工放置一块煤/铁板块（绕过建造校验，直接改 board）。 */
function place(
  s: GameState,
  loc: LocationId,
  slot: number,
  industry: 'coal' | 'iron',
  player: PlayerIndex,
  resources: number,
  flipped = false,
): void {
  const def = tileDef(industry, 1);
  if (!def) throw new Error('missing tile def');
  s.board.slots[loc]![slot] = { tile: def, player, flipped, resources };
}

/** 手工铺一条 Link（linkIndex 为 0 基，= rules-reference §1.2 的 # - 1）。 */
function build(s: GameState, linkIndex: number, player: PlayerIndex): void {
  s.board.links.push({ linkIndex, player, era: 'canal' });
}

describe('playerNetwork', () => {
  it('network includes tile locations and both endpoints of owned links', () => {
    const s = newGame(4, 1);
    place(s, 'birmingham', 2, 'iron', 0, 4); // birmingham 槽 2 = iron
    place(s, 'dudley', 0, 'coal', 0, 2);
    build(s, 3, 0); // #4 birmingham-dudley
    build(s, 8, 0); // #9 birmingham-walsall
    build(s, 0, 1); // #1 belper-derby（对手的不算）

    const net = playerNetwork(s, 0);
    expect(net.has('birmingham')).toBe(true); // 有板块
    expect(net.has('dudley')).toBe(true); // 有板块 + link 端点
    expect(net.has('walsall')).toBe(true); // 自有 link 另一端点
    expect(net.has('belper')).toBe(false);
    expect(net.has('derby')).toBe(false);
    expect(net.has('coventry')).toBe(false);
  });

  it('owned link endpoints include merchants and farm extra endpoints', () => {
    const s = newGame(4, 1);
    build(s, 35, 0); // #36 stoke-on-trent-warrington
    build(s, 29, 0); // #30 kidderminster-worcester（额外端点 farm-south）
    const net = playerNetwork(s, 0);
    expect(net.has('stoke-on-trent')).toBe(true);
    expect(net.has('warrington')).toBe(true);
    expect(net.has('kidderminster')).toBe(true);
    expect(net.has('worcester')).toBe(true);
    expect(net.has('farm-south')).toBe(true);
  });
});

describe('isConnected / connectedMerchants', () => {
  it('merchant connection does not require a merchant tile (2p warrington still connects market)', () => {
    const s = newGame(2, 1); // 2p：warrington 无商人板块
    expect(s.merchants.warrington.tiles).toHaveLength(0);
    place(s, 'stoke-on-trent', 1, 'iron', 0, 4);
    build(s, 35, 0); // #36 stoke-on-trent-warrington
    expect(isConnected(s, 0, 'warrington')).toBe(true);
    expect(connectedMerchants(s, 0)).toContain('warrington');
    expect(canBuyCoalFromMarket(s, 'stoke-on-trent')).toBe(true);
  });

  it('connectivity traverses links built by any player', () => {
    const s = newGame(2, 1);
    place(s, 'stoke-on-trent', 1, 'iron', 0, 4);
    build(s, 35, 1); // 对手铺的 stoke-warrington 照样可用
    expect(playerNetwork(s, 0).has('warrington')).toBe(false); // 不是自己的 link
    expect(isConnected(s, 0, 'warrington')).toBe(true);
    expect(canBuyCoalFromMarket(s, 'stoke-on-trent')).toBe(true);
  });

  it('no path to any merchant space → cannot buy coal from market', () => {
    const s = newGame(4, 1);
    place(s, 'stoke-on-trent', 1, 'iron', 0, 4);
    expect(connectedMerchants(s, 0)).toEqual([]);
    expect(canBuyCoalFromMarket(s, 'stoke-on-trent')).toBe(false);
  });

  it('buy-coal anchor is the build location, not the player network (isolated build site)', () => {
    // 反例 (a)：玩家 network 在 stoke 接通 warrington，但建造地点 belper 孤立 → false
    const s = newGame(2, 1);
    place(s, 'stoke-on-trent', 1, 'iron', 0, 4);
    build(s, 35, 0); // stoke-warrington（自己）
    expect(connectedMerchants(s, 0)).toContain('warrington'); // network 确实接通商人
    expect(canBuyCoalFromMarket(s, 'belper')).toBe(false); // 但建造点不连通
    expect(canBuyCoalFromMarket(s, 'stoke-on-trent')).toBe(true);
  });

  it('buy-coal anchor works with empty network via opponent links (first-build special case)', () => {
    // 反例 (b)：首建特例 network 为空，建造点经对手 link 接通商人 → true
    const s = newGame(4, 1);
    build(s, 35, 1); // 对手铺的 stoke-warrington
    expect(playerNetwork(s, 0).size).toBe(0);
    expect(connectedMerchants(s, 0)).toEqual([]);
    expect(canBuyCoalFromMarket(s, 'stoke-on-trent')).toBe(true);
    expect(canBuyCoalFromMarket(s, 'belper')).toBe(false);
  });

  it('reaches via multi-hop mixed-ownership links; unlinked locations are not connected', () => {
    const s = newGame(4, 1);
    place(s, 'belper', 1, 'coal', 0, 2);
    build(s, 0, 1); // #1 belper-derby（对手）
    build(s, 23, 1); // #24 derby-nottingham（对手）
    expect(isConnected(s, 0, 'derby')).toBe(true);
    expect(isConnected(s, 0, 'nottingham')).toBe(true);
    expect(isConnected(s, 0, 'leek')).toBe(false); // #2 是 rail-only，未铺也不通
  });

  it('rail-only links do not connect in canal era but do in rail era', () => {
    const s = newGame(4, 1);
    place(s, 'belper', 1, 'coal', 0, 2);
    build(s, 1, 1); // #2 belper-leek（rail only，对手铺的——避免端点落入自己 network）
    expect(isConnected(s, 0, 'leek')).toBe(false);
    s.era = 'rail';
    expect(isConnected(s, 0, 'leek')).toBe(true);
  });

  it('connectedMerchants sorted lexicographically (deterministic)', () => {
    const s = newGame(4, 1);
    place(s, 'derby', 2, 'iron', 0, 4);
    place(s, 'stoke-on-trent', 1, 'iron', 0, 4);
    build(s, 23, 0); // derby-nottingham
    build(s, 34, 1); // stoke-stone（对手，接通 stoke-warrington）
    build(s, 35, 1); // stoke-warrington（对手）
    expect(connectedMerchants(s, 0)).toEqual(['nottingham', 'warrington']);
  });
});

describe('coalSources', () => {
  it('coal sources sorted by distance, nearest first; ties by LocationId lexicographic', () => {
    const s = newGame(4, 1);
    place(s, 'birmingham', 2, 'iron', 0, 4); // 消费地点
    build(s, 3, 1); // birmingham-dudley
    build(s, 26, 0); // dudley-wolverhampton
    build(s, 21, 1); // coalbrookdale-wolverhampton
    place(s, 'dudley', 0, 'coal', 1, 2); // 距离 1
    place(s, 'coalbrookdale', 2, 'coal', 2, 2); // 距离 3
    const srcs = coalSources(s, 0, 'birmingham');
    expect(srcs.map((x) => x.location)).toEqual(['dudley', 'coalbrookdale']);
  });

  it('equal-distance ties broken by LocationId lexicographic', () => {
    const s = newGame(4, 1);
    build(s, 0, 0); // belper-derby
    build(s, 11, 1); // burton-on-trent-derby
    place(s, 'belper', 1, 'coal', 0, 2); // 距离 1
    place(s, 'burton-on-trent', 0, 'coal', 1, 2); // 距离 1
    const srcs = coalSources(s, 0, 'derby');
    expect(srcs.map((x) => x.location)).toEqual(['belper', 'burton-on-trent']);
  });

  it('mine at the consuming location has distance 0, no links needed', () => {
    const s = newGame(4, 1);
    place(s, 'dudley', 0, 'coal', 1, 2);
    const srcs = coalSources(s, 0, 'dudley');
    expect(srcs.map((x) => x.location)).toEqual(['dudley']);
  });

  it('exhausted or flipped mines are skipped (耗尽取下近者); unreachable mines excluded', () => {
    const s = newGame(4, 1);
    build(s, 3, 0); // birmingham-dudley
    build(s, 26, 0); // dudley-wolverhampton
    build(s, 21, 0); // coalbrookdale-wolverhampton
    place(s, 'dudley', 0, 'coal', 0, 0); // 耗尽
    place(s, 'coalbrookdale', 2, 'coal', 1, 2);
    place(s, 'belper', 1, 'coal', 1, 2); // 不连通
    let srcs = coalSources(s, 0, 'birmingham');
    expect(srcs.map((x) => x.location)).toEqual(['coalbrookdale']);

    // 翻面煤矿也不算源
    s.board.slots['dudley']![0]!.resources = 2;
    s.board.slots['dudley']![0]!.flipped = true;
    srcs = coalSources(s, 0, 'birmingham');
    expect(srcs.map((x) => x.location)).toEqual(['coalbrookdale']);
  });
});

describe('ironSources', () => {
  it('lists all unflipped iron works anywhere, no connectivity required', () => {
    const s = newGame(4, 1);
    place(s, 'dudley', 1, 'iron', 1, 4);
    place(s, 'birmingham', 2, 'iron', 0, 4);
    place(s, 'coalbrookdale', 0, 'iron', 2, 4, true); // 翻面，排除
    place(s, 'coventry', 2, 'iron', 3, 0); // 耗尽，排除
    const srcs = ironSources(s);
    expect(srcs.map((x) => x.location)).toEqual(['birmingham', 'dudley']);
    expect(srcs.every((x) => !x.tile.flipped && x.tile.resources > 0)).toBe(true);
  });
});
