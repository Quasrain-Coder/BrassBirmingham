import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { enumerateSells, applySell } from '../src/actions/sell.js';
import { IllegalActionError } from '../src/errors.js';
import { LOCATIONS } from '../src/data/board.js';
import { BREWERY_BARRELS } from '../src/data/market.js';
import { tileDef } from '../src/data/tiles.js';
import type { Action, IndustryType, LocationId, MerchantId, PlayerIndex } from '../src/types.js';

type SellAction = Extract<Action, { type: 'sell' }>;

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

/** 辅助：覆盖某商人位的板块与啤酒。 */
function setMerchant(
  state: GameState,
  id: MerchantId,
  tiles: ('any' | 'cotton' | 'manufacturer' | 'pottery' | 'blank')[],
  beer: number,
): void {
  state.merchants[id] = { tiles, beer };
}

/** 辅助：已建 Link（0 基下标；连通判定不看属主）。 */
function withLink(state: GameState, linkIndex: number, player: PlayerIndex = 0): void {
  state.board.links.push({ linkIndex, player, era: 'canal' });
}

/** 辅助：单手牌，枚举计数可控。 */
function oneCard(state: GameState, player: PlayerIndex = 0): void {
  state.players[player]!.hand = [{ id: 'c1', kind: 'industry', industries: ['cotton'] }];
}

function sellActions(state: GameState, player: PlayerIndex = 0): SellAction[] {
  return enumerateSells(state, player).filter((a): a is SellAction => a.type === 'sell');
}

// 0 基 Link 下标速查：birmingham-coventry=2，birmingham-oxford=5，
// gloucester-worcester=28，redditch-oxford=32，stoke-stone=34，stoke-warrington=35。

describe('sell', () => {
  it('sell requires connection to a merchant tile with matching icon; any-tile accepts all', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'cotton');
    withTile(s, 0, 'derby', 'brewery'); // 自己的酒厂供啤酒（无需连通）
    setMerchant(s, 'oxford', ['any'], 1);

    // 无 Link：birmingham 不可达 oxford → 无枚举
    expect(sellActions(s)).toHaveLength(0);

    // 连通但图标不匹配（pottery 板块不收 cotton）→ 无枚举
    withLink(s, 5);
    setMerchant(s, 'oxford', ['pottery'], 1);
    expect(sellActions(s)).toHaveLength(0);

    // 换 any 板块 → 有枚举
    setMerchant(s, 'oxford', ['any'], 1);
    const sells = sellActions(s);
    expect(sells.length).toBeGreaterThan(0);
    expect(sells.every((a) => a.sales[0]!.merchant === 'oxford')).toBe(true);
  });

  it('using merchant beer grants that merchant bonus (oxford +2 income spaces)', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'cotton'); // cotton 1：beerToFlip 1、incomeAdvance 5
    withLink(s, 5);
    setMerchant(s, 'oxford', ['any'], 1);
    // 全图无酒厂：唯一啤酒来源是 oxford 的桶 → 只枚举 useMerchantBeer: true
    const sells = sellActions(s);
    expect(sells).toHaveLength(1);
    expect(sells[0]!.sales[0]!.useMerchantBeer).toBe(true);

    const { state: after, events } = applySell(s, 0, sells[0]!);
    // 商人奖励 +2 格收入，翻面 +5 格：10 → 17；vp/现金不变
    expect(after.players[0]!.incomeSpace).toBe(17);
    expect(after.players[0]!.vp).toBe(0);
    expect(after.players[0]!.money).toBe(17);
    expect(after.merchants.oxford.beer).toBe(0);
    expect(after.board.slots['birmingham']![0]!.flipped).toBe(true);
    expect(events).toContainEqual({ kind: 'merchant-bonus', player: 0, merchant: 'oxford' });
    expect(events).toContainEqual({
      kind: 'flip',
      player: 0,
      location: 'birmingham',
      incomeAdvance: 5,
    });
    // 弃牌由 Task 11 统一处理：applySell 不动手牌与弃牌堆
    expect(after.players[0]!.hand).toHaveLength(1);
    expect(after.discard).toHaveLength(s.discard.length);
  });

  it('merchant beer is usable only from the merchant you sell to', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'cotton');
    withLink(s, 5); // 只连通 oxford
    setMerchant(s, 'oxford', ['any'], 1);
    setMerchant(s, 'shrewsbury', ['any'], 1); // 不连通

    const sells = sellActions(s);
    // 枚举中不存在卖到 shrewsbury 的组合
    expect(sells.some((a) => a.sales.some((x) => x.merchant === 'shrewsbury'))).toBe(false);

    const { state: after } = applySell(s, 0, sells[0]!);
    // 用的是 oxford 的桶；shrewsbury 的桶原样保留
    expect(after.merchants.oxford.beer).toBe(0);
    expect(after.merchants.shrewsbury.beer).toBe(1);

    // 商人位无桶时不存在 useMerchantBeer: true 分支
    const s2 = newGame(4, 9);
    oneCard(s2);
    withTile(s2, 0, 'birmingham', 'cotton');
    withLink(s2, 5);
    setMerchant(s2, 'oxford', ['any'], 0);
    expect(sellActions(s2).some((a) => a.sales.some((x) => x.useMerchantBeer))).toBe(false);
  });

  it('drinking opponent brewery last barrel flips it (opponent gains income)', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'stoke-on-trent', 'cotton'); // cotton 1：beerToFlip 1
    withTile(s, 1, 'stone', 'brewery'); // 对手酒厂，运河时代 1 桶
    withLink(s, 34); // stoke-stone
    withLink(s, 35); // stoke-warrington
    setMerchant(s, 'warrington', ['any'], 0);

    const sells = sellActions(s);
    expect(sells).toHaveLength(1);
    const { state: after, events } = applySell(s, 0, sells[0]!);
    // 对手酒厂被喝空 → 立即翻面，对手进收入（brewery 1 前进 4 格）
    const brewery = after.board.slots['stone']!.find((t) => t !== null)!;
    expect(brewery.flipped).toBe(true);
    expect(after.players[1]!.incomeSpace).toBe(14);
    // 连锁翻面事件在前，所卖板块翻面在后
    expect(events).toEqual([
      { kind: 'flip', player: 1, location: 'stone', incomeAdvance: 4 },
      { kind: 'flip', player: 0, location: 'stoke-on-trent', incomeAdvance: 5 },
    ]);
    expect(after.players[0]!.incomeSpace).toBe(15);
  });

  it('sale needing 2 beer is not enumerated when only 1 is available', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'manufacturer', 5); // beerToFlip 2
    withLink(s, 5);
    setMerchant(s, 'oxford', ['manufacturer'], 1);
    // 全图仅商人 1 桶 → 不可枚举
    expect(sellActions(s)).toHaveLength(0);

    // 加自己的酒厂（1 桶，无需连通）→ 2 桶齐了，且必须带商人桶才够
    withTile(s, 0, 'derby', 'brewery');
    const sells = sellActions(s);
    expect(sells).toHaveLength(1);
    expect(sells[0]!.sales[0]!.useMerchantBeer).toBe(true);
    const { state: after } = applySell(s, 0, sells[0]!);
    expect(after.board.slots['birmingham']![0]!.flipped).toBe(true);
  });

  it('one sell action can flip multiple tiles of mixed industries', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'cotton');
    withTile(s, 0, 'coventry', 'pottery');
    withTile(s, 0, 'derby', 'brewery');
    withTile(s, 0, 'stone', 'brewery');
    withLink(s, 2); // birmingham-coventry
    withLink(s, 5); // birmingham-oxford
    setMerchant(s, 'oxford', ['any'], 0);

    const sells = sellActions(s);
    const full = sells.filter((a) => a.sales.length === 2);
    expect(full).toHaveLength(1); // 多块只枚举"可卖全集"一个行动
    expect(sells.filter((a) => a.sales.length === 1)).toHaveLength(2); // 每块单独卖各一

    const { state: after, events } = applySell(s, 0, full[0]!);
    expect(after.board.slots['birmingham']![0]!.flipped).toBe(true);
    expect(after.board.slots['coventry']![0]!.flipped).toBe(true);
    // 两块各 +5；两块运河时代 1 桶酒厂被喝空连锁翻面各 +4：10 + 5+4 + 5+4 = 28
    expect(after.players[0]!.incomeSpace).toBe(28);
    // 事件序：每次销售先来源翻面后所卖板块翻面；derby 字典序先于 stone 被喝
    expect(events).toEqual([
      { kind: 'flip', player: 0, location: 'derby', incomeAdvance: 4 },
      { kind: 'flip', player: 0, location: 'birmingham', incomeAdvance: 5 },
      { kind: 'flip', player: 0, location: 'stone', incomeAdvance: 4 },
      { kind: 'flip', player: 0, location: 'coventry', incomeAdvance: 5 },
    ]);
  });

  it('intermediate subsets: max set minus one tile each is enumerated (sell exactly 2 of 3)', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'cotton');
    withTile(s, 0, 'coventry', 'pottery');
    withTile(s, 0, 'redditch', 'manufacturer');
    withTile(s, 0, 'derby', 'brewery');
    withTile(s, 0, 'stone', 'brewery');
    withTile(s, 0, 'burton-on-trent', 'brewery');
    withLink(s, 2);
    withLink(s, 5);
    withLink(s, 32); // redditch-oxford
    setMerchant(s, 'oxford', ['any'], 0);

    const sells = sellActions(s);
    // 3 块可卖：单块 ×3 + 最大集 ×1 + 减一子集 ×3（规则书 p.10 step 5：每块可选）
    expect(sells).toHaveLength(7);
    expect(sells.filter((a) => a.sales.length === 3)).toHaveLength(1);
    expect(sells.filter((a) => a.sales.length === 2)).toHaveLength(3);
  });

  it('gloucester merchant bonus settles a free develop (no iron, lightbulb pottery exempt)', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'worcester', 'cotton');
    withLink(s, 28); // gloucester-worcester
    setMerchant(s, 'gloucester', ['any'], 1);

    const sells = sellActions(s);
    expect(sells).toHaveLength(1);
    expect(sells[0]!.sales[0]!.useMerchantBeer).toBe(true);

    const cottonBefore = s.players[0]!.tiles.filter((t) => t.industry === 'cotton').length;
    const { state: after, events } = applySell(s, 0, sells[0]!);
    expect(events).toContainEqual({ kind: 'merchant-bonus', player: 0, merchant: 'gloucester' });
    // 免费 develop：面板移除规范化目标（产业序首个可研发栈顶 = cotton 1），不耗铁
    expect(after.players[0]!.tiles.filter((t) => t.industry === 'cotton')).toHaveLength(
      cottonBefore - 1,
    );
    expect(after.players[0]!.tiles).toHaveLength(s.players[0]!.tiles.length - 1);
    expect(after.players[0]!.money).toBe(17);
    expect(after.ironMarket).toBe(s.ironMarket);
    expect(after.players[0]!.incomeSpace).toBe(15); // 仅翻面 +5，develop 奖励不加收入
  });

  it('sale with beerToFlip 0 enumerates no phantom useMerchantBeer:true branch', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'manufacturer', 3); // beerToFlip 0
    withLink(s, 5);
    setMerchant(s, 'oxford', ['manufacturer'], 1);
    // 板块不需啤酒：无从消耗商人桶、无从得奖励 → 只有 false 分支
    const sells = sellActions(s);
    expect(sells).toHaveLength(1);
    expect(sells[0]!.sales[0]!.useMerchantBeer).toBe(false);

    const { state: after, events } = applySell(s, 0, sells[0]!);
    expect(after.merchants.oxford.beer).toBe(1); // 商人桶原样保留
    expect(events.some((e) => e.kind === 'merchant-bonus')).toBe(false);
    expect(after.board.slots['birmingham']![0]!.flipped).toBe(true);
  });

  it('gloucester bonus triggers twice when two sales each drink one of its two barrels', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'redditch', 'manufacturer'); // manufacturer 1：beerToFlip 1
    withTile(s, 0, 'worcester', 'cotton');
    withLink(s, 27); // gloucester-redditch
    withLink(s, 28); // gloucester-worcester
    setMerchant(s, 'gloucester', ['any', 'any'], 2); // 2 板块 2 桶

    // 无酒厂：两次销售各用 1 桶商人桶 → 全集中两块都是 useMerchantBeer:true
    const full = sellActions(s).filter((a) => a.sales.length === 2);
    expect(full).toHaveLength(1);
    expect(full[0]!.sales.every((x) => x.useMerchantBeer)).toBe(true);

    const { state: after, events } = applySell(s, 0, full[0]!);
    expect(after.merchants.gloucester.beer).toBe(0);
    // 2 次 MerchantBonusEvent + 2 次免费 develop（产业序首个：cotton 栈顶连移 2 块）
    expect(events.filter((e) => e.kind === 'merchant-bonus')).toEqual([
      { kind: 'merchant-bonus', player: 0, merchant: 'gloucester' },
      { kind: 'merchant-bonus', player: 0, merchant: 'gloucester' },
    ]);
    expect(after.players[0]!.tiles).toHaveLength(s.players[0]!.tiles.length - 2);
    expect(after.players[0]!.tiles.filter((t) => t.industry === 'cotton')).toHaveLength(
      s.players[0]!.tiles.filter((t) => t.industry === 'cotton').length - 2,
    );
    expect(after.players[0]!.money).toBe(17); // 免费 develop 不耗铁不花钱
    // cotton 1 与 manufacturer 1 各 +5
    expect(after.players[0]!.incomeSpace).toBe(20);
  });

  it('applySell rejects an action outside the enumerated set', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'cotton');
    withLink(s, 5);
    setMerchant(s, 'oxford', ['any'], 1);
    // 无酒厂：啤酒只有商人桶 → useMerchantBeer: false 不在枚举集
    expect(() =>
      applySell(s, 0, {
        type: 'sell',
        cardId: 'c1',
        sales: [{ location: 'birmingham', slotIndex: 0, merchant: 'oxford', useMerchantBeer: false }],
      }),
    ).toThrowError(IllegalActionError);
    expect(() =>
      applySell(s, 0, { type: 'pass', cardId: 'c1' }),
    ).toThrowError(IllegalActionError);
  });

  it('flipped tiles and other players tiles are not sellable', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'cotton');
    withTile(s, 1, 'coventry', 'pottery'); // 对手的
    withTile(s, 0, 'derby', 'brewery');
    withLink(s, 2);
    withLink(s, 5);
    setMerchant(s, 'oxford', ['any'], 0);
    s.board.slots['birmingham']![0]!.flipped = true; // 已翻面

    expect(sellActions(s)).toHaveLength(0);
    // 对手视角：连通与啤酒（自己的酒厂，无需连通）够，也只有自己的 pottery 可卖
    withTile(s, 1, 'stone', 'brewery');
    s.players[1]!.hand = [{ id: 'c2', kind: 'industry', industries: ['pottery'] }];
    const sells = sellActions(s, 1);
    expect(sells).toHaveLength(1);
    expect(sells[0]!.sales[0]!.location).toBe('coventry');
  });
});
