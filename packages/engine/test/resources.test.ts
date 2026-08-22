import { describe, expect, it } from 'vitest';
import { IllegalActionError } from '../src/errors.js';
import { newGame, type GameState } from '../src/state.js';
import { tileDef } from '../src/data/tiles.js';
import { applyFlip, consumeBeer, consumeCoal, consumeIron } from '../src/resources.js';
import type { LocationId, MerchantId, PlayerIndex } from '../src/types.js';
import type { MerchantTile } from '../src/state.js';

type ResourceIndustry = 'coal' | 'iron' | 'brewery';

/** 手工放置一块资源板块（绕过建造校验，直接改 board）。 */
function place(
  s: GameState,
  loc: LocationId,
  slot: number,
  industry: ResourceIndustry,
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

/** 直接覆写某商人位的板块与啤酒（初始设置洗混不确定，测试显式给定）。 */
function setMerchant(s: GameState, id: MerchantId, tiles: MerchantTile[], beer: number): void {
  // 桶按板块格绑定:前 beer 个非 blank 格有桶(与 UI 从左填充一致)
  let left = beer;
  s.merchants[id] = {
    tiles,
    barrels: tiles.map((t) => {
      if (t === 'blank' || left <= 0) return false;
      left -= 1;
      return true;
    }),
  };
}

// 板块数值锚点（data/tiles.ts）：coal L1 incomeAdvance 4、iron L1 incomeAdvance 3、
// brewery L1 incomeAdvance 4；收入起始格 10。
// 市场锚点（data/market.ts）：煤初始 filled 13 → 第 1 块 £1、第 2 块 £2；
// 铁初始 filled 8 → 第 1、2 块各 £2。起始现金 £17。

describe('applyFlip', () => {
  it('flips tile and advances owner income by tile incomeAdvance', () => {
    const s = newGame(4, 1);
    place(s, 'dudley', 0, 'coal', 1, 0); // owner=玩家 1，已耗尽待翻
    const { state, event } = applyFlip(s, 'dudley', 0);
    expect(event).toEqual({ kind: 'flip', player: 1, location: 'dudley', incomeAdvance: 4 });
    expect(state.board.slots['dudley']![0]!.flipped).toBe(true);
    expect(state.players[1]!.incomeSpace).toBe(14); // 10 + 4
    // 纯函数：入参不变
    expect(s.board.slots['dudley']![0]!.flipped).toBe(false);
    expect(s.players[1]!.incomeSpace).toBe(10);
  });

  it('throws cannot-flip on empty slot or already-flipped tile', () => {
    const s = newGame(4, 1);
    expect(() => applyFlip(s, 'dudley', 0)).toThrowError(/cannot-flip/);
    place(s, 'dudley', 0, 'coal', 1, 0, true); // 已翻面
    expect(() => applyFlip(s, 'dudley', 0)).toThrowError(IllegalActionError);
    expect(() => applyFlip(s, 'dudley', 0)).toThrowError(/cannot-flip/);
  });

  it('income advance clamps at track end (level 30 cap), event keeps nominal advance', () => {
    const s = newGame(4, 1);
    place(s, 'dudley', 0, 'coal', 1, 0);
    s.players[1]!.incomeSpace = 98;
    const { state, event } = applyFlip(s, 'dudley', 0);
    expect(state.players[1]!.incomeSpace).toBe(99); // 上限格
    expect(event.incomeAdvance).toBe(4); // 事件记板块标称值
  });
});

describe('consumeCoal', () => {
  it('coal consumption flips mine when last cube removed, advancing income', () => {
    const s = newGame(4, 1);
    place(s, 'dudley', 0, 'coal', 1, 2); // 矿上 2 块，owner=玩家 1
    const { state, flipped } = consumeCoal(s, 0, 'dudley', 2);
    expect(flipped).toEqual([{ kind: 'flip', player: 1, location: 'dudley', incomeAdvance: 4 }]);
    expect(state.players[1]!.incomeSpace).toBe(14);
    const mine = state.board.slots['dudley']![0]!;
    expect(mine.resources).toBe(0);
    expect(mine.flipped).toBe(true);
    expect(state.players[0]!.money).toBe(17); // 免费煤不花钱
  });

  it('takes from nearest connected mine first, draining it before the next', () => {
    const s = newGame(4, 1);
    build(s, 3, 1); // #4 birmingham-dudley
    build(s, 26, 1); // #27 dudley-wolverhampton
    build(s, 21, 1); // #22 coalbrookdale-wolverhampton
    place(s, 'dudley', 0, 'coal', 0, 1); // 距离 1，仅 1 块
    place(s, 'coalbrookdale', 2, 'coal', 1, 2); // 距离 3
    const { state, flipped } = consumeCoal(s, 0, 'birmingham', 2);
    // dudley 耗尽翻面（owner 玩家 0），coalbrookdale 出 1 块不翻
    expect(flipped).toEqual([{ kind: 'flip', player: 0, location: 'dudley', incomeAdvance: 4 }]);
    expect(state.board.slots['dudley']![0]!.flipped).toBe(true);
    expect(state.board.slots['coalbrookdale']![2]!.resources).toBe(1);
    expect(state.board.slots['coalbrookdale']![2]!.flipped).toBe(false);
    expect(state.players[0]!.incomeSpace).toBe(14);
    expect(state.coalMarket).toBe(13); // 全程免费，未动市场
  });

  it('free coal insufficient → buys remainder from market when connected', () => {
    const s = newGame(4, 1);
    build(s, 35, 1); // #36 stoke-on-trent-warrington（连通商人位）
    place(s, 'stoke-on-trent', 0, 'coal', 1, 1); // 免费仅 1 块
    const { state, flipped } = consumeCoal(s, 0, 'stoke-on-trent', 2);
    expect(flipped).toEqual([
      { kind: 'flip', player: 1, location: 'stoke-on-trent', incomeAdvance: 4 },
    ]);
    expect(state.coalMarket).toBe(12); // 市场买 1 块
    expect(state.players[0]!.money).toBe(16); // £1（filled 13 时最便宜已填格）
    expect(state.players[0]!.spentThisRound).toBe(1);
  });

  it('coal from market requires merchant connection, else throws coal-not-connected', () => {
    const s = newGame(4, 1); // 无任何板块与 link → belper 无免费煤、不连通商人位
    expect(() => consumeCoal(s, 0, 'belper', 1)).toThrowError(/coal-not-connected/);
    try {
      consumeCoal(s, 0, 'belper', 1);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalActionError);
      expect((e as IllegalActionError).code).toBe('coal-not-connected');
    }
  });

  it('market buy beyond player funds throws insufficient-funds', () => {
    const s = newGame(4, 1);
    build(s, 35, 1); // stoke-warrington 连通
    s.players[0]!.money = 0;
    expect(() => consumeCoal(s, 0, 'stoke-on-trent', 1)).toThrowError(/insufficient-funds/);
  });

  it('market empty → fallback price £8 per cube', () => {
    const s = newGame(4, 1);
    build(s, 35, 1); // stoke-warrington 连通
    s.coalMarket = 0;
    const { state } = consumeCoal(s, 0, 'stoke-on-trent', 1);
    expect(state.players[0]!.money).toBe(9); // 17 - 8
    expect(state.coalMarket).toBe(0);
  });
});

describe('consumeIron', () => {
  it('iron consumption needs no connectivity', () => {
    const s = newGame(4, 1);
    place(s, 'worcester', 0, 'iron', 1, 4); // 孤立地点，无任何 link
    const { state, flipped } = consumeIron(s, 0, 1);
    expect(state.board.slots['worcester']![0]!.resources).toBe(3);
    expect(flipped).toEqual([]);
    expect(state.players[0]!.money).toBe(17);
  });

  it('normalization: first works (lexicographic) with enough cubes supplies all', () => {
    const s = newGame(4, 1);
    place(s, 'birmingham', 2, 'iron', 0, 1); // 字典序在前但只有 1 块
    place(s, 'coalbrookdale', 1, 'iron', 1, 4); // 首个有足够方块者
    const { state, flipped } = consumeIron(s, 0, 2);
    expect(state.board.slots['birmingham']![2]!.resources).toBe(1); // 未动
    expect(state.board.slots['coalbrookdale']![1]!.resources).toBe(2);
    expect(flipped).toEqual([]);
  });

  it('mixes across works in lexicographic order when none has enough', () => {
    const s = newGame(4, 1);
    place(s, 'birmingham', 2, 'iron', 1, 1);
    place(s, 'coalbrookdale', 1, 'iron', 1, 1);
    place(s, 'dudley', 1, 'iron', 1, 2);
    const { state, flipped } = consumeIron(s, 0, 3);
    expect(flipped).toEqual([
      { kind: 'flip', player: 1, location: 'birmingham', incomeAdvance: 3 },
      { kind: 'flip', player: 1, location: 'coalbrookdale', incomeAdvance: 3 },
    ]);
    expect(state.board.slots['dudley']![1]!.resources).toBe(1);
    expect(state.players[1]!.incomeSpace).toBe(16); // 10 + 3 + 3
  });

  it('iron exhaustion flips works and advances owner income', () => {
    const s = newGame(4, 1);
    place(s, 'dudley', 1, 'iron', 1, 1);
    const { state, flipped } = consumeIron(s, 0, 1);
    expect(flipped).toEqual([{ kind: 'flip', player: 1, location: 'dudley', incomeAdvance: 3 }]);
    expect(state.players[1]!.incomeSpace).toBe(13);
    expect(state.board.slots['dudley']![1]!.flipped).toBe(true);
  });

  it('insufficient works → market buy, no connectivity required', () => {
    const s = newGame(4, 1); // 无铁厂、无 link
    const { state, flipped } = consumeIron(s, 0, 2);
    expect(flipped).toEqual([]);
    expect(state.ironMarket).toBe(6);
    expect(state.players[0]!.money).toBe(13); // 17 - (2 + 2)
    expect(state.players[0]!.spentThisRound).toBe(4);
  });

  it('market buy beyond player funds throws insufficient-funds', () => {
    const s = newGame(4, 1);
    s.players[0]!.money = 1;
    expect(() => consumeIron(s, 0, 2)).toThrowError(/insufficient-funds/);
  });
});

describe('consumeBeer', () => {
  it('own brewery works from anywhere (no connectivity); last barrel flips it', () => {
    const s = newGame(4, 1);
    place(s, 'uttoxeter', 0, 'brewery', 0, 1); // 自己的孤立酒厂
    const r = consumeBeer(s, 0, 1, { at: 'belper', useMerchantBeer: false });
    expect(r.flipped).toEqual([{ kind: 'flip', player: 0, location: 'uttoxeter', incomeAdvance: 4 }]);
    expect(r.state.players[0]!.incomeSpace).toBe(14);
    expect(r.state.board.slots['uttoxeter']![0]!.flipped).toBe(true);
    expect(r.merchantBonus).toBeUndefined();
  });

  it('opponent brewery requires connectivity to point of use', () => {
    const s = newGame(4, 1);
    place(s, 'derby', 0, 'brewery', 1, 1); // 对手酒厂
    // 无 link：不连通 → 无法消耗
    expect(() => consumeBeer(s, 0, 1, { at: 'belper', useMerchantBeer: false })).toThrowError(
      /insufficient-beer/,
    );
    // 铺上 belper-derby 后连通 → 可消耗，对手酒厂翻面、对手进收入
    build(s, 0, 1);
    const r = consumeBeer(s, 0, 1, { at: 'belper', useMerchantBeer: false });
    expect(r.flipped).toEqual([{ kind: 'flip', player: 1, location: 'derby', incomeAdvance: 4 }]);
    expect(r.state.players[1]!.incomeSpace).toBe(14);
  });

  it('merchant beer triggers merchant bonus (oxford income +2)', () => {
    const s = newGame(4, 1);
    setMerchant(s, 'oxford', ['any', 'cotton'], 2);
    const r = consumeBeer(s, 0, 1, { at: 'oxford', useMerchantBeer: true, industry: 'cotton' });
    expect(r.merchantBonus).toEqual({ kind: 'merchant-bonus', player: 0, merchant: 'oxford' });
    expect(r.state.merchants.oxford.barrels.filter(Boolean).length).toBe(1);
    expect(r.state.players[0]!.incomeSpace).toBe(12); // 10 + 2
    expect(r.flipped).toEqual([]);
  });

  it('merchant beer is preferred over own breweries when useMerchantBeer', () => {
    const s = newGame(4, 1);
    setMerchant(s, 'oxford', ['any'], 1);
    place(s, 'derby', 0, 'brewery', 0, 1);
    const r = consumeBeer(s, 0, 1, { at: 'oxford', useMerchantBeer: true, industry: 'cotton' });
    expect(r.state.merchants.oxford.barrels.filter(Boolean).length).toBe(0); // 商人桶被用
    expect(r.state.board.slots['derby']![0]!.resources).toBe(1); // 自己酒厂未动
    expect(r.merchantBonus?.merchant).toBe('oxford');
  });

  it('useMerchantBeer=false never touches merchant beer', () => {
    const s = newGame(4, 1);
    setMerchant(s, 'oxford', ['any'], 1);
    expect(() => consumeBeer(s, 0, 1, { at: 'oxford', useMerchantBeer: false })).toThrowError(
      /insufficient-beer/,
    );
    expect(s.merchants.oxford.barrels.filter(Boolean).length).toBe(1);
  });

  it('merchant beer only from the merchant named by at', () => {
    const s = newGame(4, 1);
    setMerchant(s, 'oxford', ['any'], 0);
    setMerchant(s, 'warrington', ['any'], 1);
    expect(() => consumeBeer(s, 0, 1, { at: 'oxford', useMerchantBeer: true, industry: 'cotton' })).toThrowError(
      /insufficient-beer/,
    );
  });

  it('gloucester develop bonus is emitted but not settled here', () => {
    const s = newGame(4, 1);
    setMerchant(s, 'gloucester', ['any', 'pottery'], 1);
    const r = consumeBeer(s, 0, 1, { at: 'gloucester', useMerchantBeer: true, industry: 'cotton' });
    expect(r.merchantBonus).toEqual({ kind: 'merchant-bonus', player: 0, merchant: 'gloucester' });
    expect(r.state.merchants.gloucester.barrels.filter(Boolean).length).toBe(0);
    // develop 奖励不在此结算：钱/VP/收入轨均不变
    expect(r.state.players[0]!.money).toBe(17);
    expect(r.state.players[0]!.vp).toBe(0);
    expect(r.state.players[0]!.incomeSpace).toBe(10);
  });

  it('money and vp merchant bonuses are settled here (warrington +£5, shrewsbury +4 VP)', () => {
    const s = newGame(4, 1);
    setMerchant(s, 'warrington', ['any'], 1);
    const r1 = consumeBeer(s, 0, 1, { at: 'warrington', useMerchantBeer: true, industry: 'cotton' });
    expect(r1.state.players[0]!.money).toBe(22);

    const s2 = newGame(4, 1);
    setMerchant(s2, 'shrewsbury', ['any'], 1);
    const r2 = consumeBeer(s2, 0, 1, { at: 'shrewsbury', useMerchantBeer: true, industry: 'cotton' });
    expect(r2.state.players[0]!.vp).toBe(4);
  });

  it('source normalization: own breweries before connected opponent breweries', () => {
    const s = newGame(4, 1);
    place(s, 'derby', 0, 'brewery', 0, 1); // 自己
    place(s, 'belper', 1, 'brewery', 1, 1); // 对手（at 同地点，距离 0 连通）
    const r = consumeBeer(s, 0, 1, { at: 'belper', useMerchantBeer: false });
    expect(r.flipped).toEqual([{ kind: 'flip', player: 0, location: 'derby', incomeAdvance: 4 }]);
    expect(r.state.board.slots['belper']![1]!.resources).toBe(1); // 对手酒厂未动

    // n=2：自己耗尽后再用对手的
    const r2 = consumeBeer(s, 0, 2, { at: 'belper', useMerchantBeer: false });
    expect(r2.flipped).toEqual([
      { kind: 'flip', player: 0, location: 'derby', incomeAdvance: 4 },
      { kind: 'flip', player: 1, location: 'belper', incomeAdvance: 4 },
    ]);
    expect(r2.state.players[0]!.incomeSpace).toBe(14);
    expect(r2.state.players[1]!.incomeSpace).toBe(14);
  });

  it('total beer insufficient → throws insufficient-beer', () => {
    const s = newGame(4, 1);
    place(s, 'derby', 0, 'brewery', 0, 1);
    expect(() => consumeBeer(s, 0, 2, { at: 'derby', useMerchantBeer: false })).toThrowError(
      /insufficient-beer/,
    );
  });
});

describe('purity', () => {
  it('consume functions do not mutate input state', () => {
    const s = newGame(4, 1);
    build(s, 35, 1);
    place(s, 'stoke-on-trent', 0, 'coal', 1, 1);
    place(s, 'dudley', 1, 'iron', 1, 1);
    setMerchant(s, 'oxford', ['any'], 1);
    const snapshot = JSON.stringify(s);
    consumeCoal(s, 0, 'stoke-on-trent', 2); // 翻面 + 市场买
    consumeIron(s, 0, 1); // 翻面
    consumeBeer(s, 0, 1, { at: 'oxford', useMerchantBeer: true, industry: 'cotton' }); // 商人桶 + 奖励
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});
