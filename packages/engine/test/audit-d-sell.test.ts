/**
 * 审计域 D：Sell 卖货（只读审计，不改 src）。
 *
 * 对照：规则书 p.8（啤酒来源，txt 行 835-866）、p.10（Sell 行动与商人啤酒奖励，
 * txt 行 1108-1184）、rules-reference §6.5 / §1.3 / §1.4 / §9.11 / §9.12。
 *
 * 本文件包含两类测试：
 * - 'audit bug' 开头：预期**失败**——复现"违反规则书且违反 rules-reference"的枚举漏。
 * - 其余：合规确认，预期通过。
 */
import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { enumerateSells, applySell } from '../src/actions/sell.js';
import { consumeBeer } from '../src/resources.js';
import { LOCATIONS } from '../src/data/board.js';
import { BREWERY_BARRELS } from '../src/data/market.js';
import { tileDef } from '../src/data/tiles.js';
import type { Action, IndustryType, LocationId, MerchantId, PlayerIndex } from '../src/types.js';

type SellAction = Extract<Action, { type: 'sell' }>;

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

function setMerchant(
  state: GameState,
  id: MerchantId,
  tiles: ('any' | 'cotton' | 'manufacturer' | 'pottery' | 'blank')[],
  beer: number,
): void {
  // 桶按板块格绑定:前 beer 个非 blank 格有桶(与 UI 从左填充一致)
  let left = beer;
  state.merchants[id] = {
    tiles,
    barrels: tiles.map((t) => {
      if (t === 'blank' || left <= 0) return false;
      left -= 1;
      return true;
    }),
  };
}

function withLink(state: GameState, linkIndex: number, player: PlayerIndex = 0): void {
  state.board.links.push({ linkIndex, player, era: state.era });
}

function oneCard(state: GameState, player: PlayerIndex = 0): void {
  state.players[player]!.hand = [{ id: 'c1', kind: 'industry', industries: ['cotton'] }];
}

function sellActions(state: GameState, player: PlayerIndex = 0): SellAction[] {
  return enumerateSells(state, player).filter((a): a is SellAction => a.type === 'sell');
}

// 0 基 Link 下标：birmingham-coventry=2，birmingham-oxford=5，
// coalbrookdale-kidderminster=19，coalbrookdale-shrewsbury=20，derby-nottingham=23，
// gloucester-redditch=27，gloucester-worcester=28，redditch-oxford=32，stoke-warrington=35。

describe('audit D: sell', () => {
  // ---------- 确证 bug 1（预期失败）----------
  it('audit bug: greedy "full set" is not maximal — a legal 2-tile Sell is neither enumerated nor applicable', () => {
    // 规则书 p.10 步骤 5 + rules-reference §9.11：一次 Sell 可对多块板块重复，
    // 每块各自检查连通与啤酒；sell.ts 头注释承诺多块枚举"可卖全集"。
    // 局面（两个互不连通的组件 + 全图仅 1 桶自有酒厂啤酒）：
    // - redditch 制造 I（beerToFlip 1），连通 gloucester（无桶）与 oxford（1 桶）；
    // - stoke-on-trent 棉 I（beerToFlip 1），只连通 warrington（无桶）；
    // - 自己 derby 酒厂 1 桶（运河时代，无需连通）。
    // 规范板块序 redditch < stoke-on-trent；贪心对 redditch 取 MERCHANTS 序首个可行
    // = gloucester(false) 喝掉唯一的酒厂桶 → stoke 棉因而无来源被剔出，"全集"仅 1 块。
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'redditch', 'manufacturer');
    withTile(s, 0, 'stoke-on-trent', 'cotton');
    withTile(s, 0, 'derby', 'brewery'); // 运河时代 1 桶
    withLink(s, 27); // gloucester-redditch
    withLink(s, 32); // redditch-oxford
    withLink(s, 35); // stoke-warrington
    setMerchant(s, 'gloucester', ['any'], 0);
    setMerchant(s, 'oxford', ['any'], 1);
    setMerchant(s, 'warrington', ['any'], 0);

    // 合法的双块 Sell 确实存在：redditch→oxford 用 oxford 商人桶，
    // stoke→warrington 用自有酒厂桶（无需连通）。两块各自满足图标连通与啤酒。
    // 期望：该双块组合被枚举且 applySell 接受；
    // 实际：枚举只有单块（贪心"全集"长度 1 不予枚举），applySell 抛 illegal-sell。
    const sells = sellActions(s);
    expect(
      sells.some(
        (a) =>
          a.sales.length === 2 &&
          a.sales.some((x) => x.location === 'redditch' && x.merchant === 'oxford') &&
          a.sales.some((x) => x.location === 'stoke-on-trent' && x.merchant === 'warrington'),
      ),
    ).toBe(true);

    expect(() =>
      applySell(s, 0, {
        type: 'sell',
        cardId: 'c1',
        sales: [
          { location: 'redditch', slotIndex: 0, merchant: 'oxford', useMerchantBeer: true },
          { location: 'stoke-on-trent', slotIndex: 0, merchant: 'warrington', useMerchantBeer: false },
        ],
      }),
    ).not.toThrow();
  });

  // ---------- 确证 bug 2（预期失败）----------
  it('audit bug: legal intermediate subset (sell exactly 2 of 3 sellable tiles) is not enumerated', () => {
    // 规则书 p.10 步骤 5："You **may** go back to step 2 and repeat"——每块可卖板块
    // 都是可选的；卖 3 块中的任意 2 块是合法行动（例如不想喝空自己酒厂触发翻面、
    // 或不想给对手酒厂翻面送收入）。rules-reference §9.11 同。
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
    withLink(s, 32);
    setMerchant(s, 'oxford', ['any'], 0);

    // 引擎只枚举单块 ×3 与三块全集 ×1；任意两块组合（合法行动）不在枚举集中，
    // applySell 也会以 illegal-sell 拒绝。
    const sells = sellActions(s);
    expect(sells.some((a) => a.sales.length === 2)).toBe(true);
  });

  // ---------- 合规确认（预期通过）----------
  it('warrington merchant beer bonus grants +£5 (R p.10, rules-reference §1.3)', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'stoke-on-trent', 'cotton');
    withLink(s, 35); // stoke-warrington
    setMerchant(s, 'warrington', ['any'], 1);

    const sells = sellActions(s);
    expect(sells).toHaveLength(1);
    expect(sells[0]!.sales[0]!.useMerchantBeer).toBe(true);
    const { state: after, events } = applySell(s, 0, sells[0]!);
    expect(after.players[0]!.money).toBe(17 + 5);
    expect(after.merchants.warrington.barrels.filter(Boolean).length).toBe(0);
    expect(after.players[0]!.incomeSpace).toBe(15); // 仅翻面 +5
    expect(events).toContainEqual({ kind: 'merchant-bonus', player: 0, merchant: 'warrington' });
  });

  it('shrewsbury merchant beer bonus grants +4 VP (R p.10, rules-reference §1.3)', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'kidderminster', 'cotton');
    withLink(s, 19); // coalbrookdale-kidderminster
    withLink(s, 20); // coalbrookdale-shrewsbury
    setMerchant(s, 'shrewsbury', ['any'], 1);

    const sells = sellActions(s);
    expect(sells).toHaveLength(1);
    const { state: after, events } = applySell(s, 0, sells[0]!);
    expect(after.players[0]!.vp).toBe(4);
    expect(after.merchants.shrewsbury.barrels.filter(Boolean).length).toBe(0);
    expect(events).toContainEqual({ kind: 'merchant-bonus', player: 0, merchant: 'shrewsbury' });
  });

  it('nottingham merchant beer bonus grants +3 VP (R p.10, rules-reference §1.3)', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'derby', 'cotton');
    withLink(s, 23); // derby-nottingham
    setMerchant(s, 'nottingham', ['any'], 1);

    const sells = sellActions(s);
    expect(sells).toHaveLength(1);
    const { state: after, events } = applySell(s, 0, sells[0]!);
    expect(after.players[0]!.vp).toBe(3);
    expect(after.merchants.nottingham.barrels.filter(Boolean).length).toBe(0);
    expect(events).toContainEqual({ kind: 'merchant-bonus', player: 0, merchant: 'nottingham' });
  });

  it('opponent brewery must be connected to the merchant sold to; own brewery needs no connection (R p.8)', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'cotton');
    withTile(s, 1, 'stone', 'brewery'); // 对手酒厂，但不连通 oxford
    withLink(s, 5); // birmingham-oxford
    setMerchant(s, 'oxford', ['any'], 0);
    // 啤酒唯一候选是未连通的对手酒厂 → 不可卖
    expect(sellActions(s)).toHaveLength(0);

    // 换自己酒厂（全图可用、无需连通）→ 可卖；运河 1 桶被喝空立即连锁翻面
    const s2 = newGame(4, 9);
    oneCard(s2);
    withTile(s2, 0, 'birmingham', 'cotton');
    withTile(s2, 0, 'derby', 'brewery');
    withLink(s2, 5);
    setMerchant(s2, 'oxford', ['any'], 0);
    const sells = sellActions(s2);
    expect(sells).toHaveLength(1);
    expect(sells[0]!.sales[0]!.useMerchantBeer).toBe(false);
    const { state: after } = applySell(s2, 0, sells[0]!);
    expect(after.board.slots['derby']![0]!.flipped).toBe(true);
    expect(after.players[0]!.incomeSpace).toBe(10 + 4 + 5); // 酒厂连锁翻面 +4，棉翻面 +5
  });

  it('merchant beer is never consumed by non-Sell beer use (double rail passes useMerchantBeer:false, R p.10/§9.12)', () => {
    const s = newGame(4, 9);
    withTile(s, 0, 'derby', 'brewery');
    setMerchant(s, 'oxford', ['any'], 1);
    // 以 LocationId 为用酒处、useMerchantBeer:false（network.ts 双轨的调用方式）：
    // 即使商人位有桶也绝不动它、不发商人奖励。
    const r = consumeBeer(s, 0, 1, { at: 'derby', useMerchantBeer: false });
    expect(r.state.merchants.oxford.barrels.filter(Boolean).length).toBe(1);
    expect(r.merchantBonus).toBeUndefined();
    expect(r.state.board.slots['derby']![0]!.flipped).toBe(true); // 自己酒厂被喝空连锁翻面
  });

  it('mixed beer sources: 2-beer tile can mix merchant barrel with own brewery (R p.8 多桶混源)', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'manufacturer', 5); // beerToFlip 2
    withTile(s, 0, 'derby', 'brewery'); // 1 桶
    withLink(s, 5);
    setMerchant(s, 'oxford', ['manufacturer'], 1);
    // 总来源 = 商人 1 + 自己酒厂 1 = 2，唯一可行组合必须带商人桶
    const sells = sellActions(s);
    expect(sells).toHaveLength(1);
    expect(sells[0]!.sales[0]!.useMerchantBeer).toBe(true);
    const { state: after } = applySell(s, 0, sells[0]!);
    expect(after.board.slots['birmingham']![0]!.flipped).toBe(true);
    expect(after.merchants.oxford.barrels.filter(Boolean).length).toBe(0);
    expect(after.board.slots['derby']![0]!.flipped).toBe(true);
  });

  it('sell to a blank-tile merchant slot is impossible; matching icon required even with beer present', () => {
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'birmingham', 'cotton');
    withTile(s, 0, 'derby', 'brewery');
    withLink(s, 5);
    // 空白板块不收货（即使人为放上啤酒桶也不收 cotton）
    setMerchant(s, 'oxford', ['blank'], 1);
    expect(sellActions(s)).toHaveLength(0);
  });

  it('同次 Sell 可卖三块(规则书 §6.5 可对多块重复):三板块×三商人组合枚举个数为 3', () => {
    // 场景(用户实测回归):stafford 陶器(酒2)→gloucester、walsall 制造(酒1)→gloucester、
    // derby 制造(酒1)→nottingham;啤酒 = gloucester 2 桶 + nottingham 1 桶 + 自家酒厂 1 桶
    const s = newGame(4, 9);
    oneCard(s);
    withTile(s, 0, 'stafford', 'pottery');
    withTile(s, 0, 'walsall', 'manufacturer', 2);
    withTile(s, 0, 'derby', 'manufacturer', 1);
    withTile(s, 0, 'uttoxeter', 'brewery');
    withLink(s, 15); // cannock-stafford
    withLink(s, 17); // cannock-walsall
    withLink(s, 8); // birmingham-walsall
    withLink(s, 5); // birmingham-oxford
    withLink(s, 32); // redditch-oxford
    withLink(s, 27); // gloucester-redditch
    withLink(s, 23); // derby-nottingham
    setMerchant(s, 'gloucester', ['manufacturer', 'any'], 2);
    setMerchant(s, 'nottingham', ['manufacturer'], 1);
    const sells = sellActions(s);
    const maxLen = Math.max(0, ...sells.map((a) => a.sales.length));
    expect(maxLen).toBe(3);
    // 自定义三组一并应用:三块全部翻面,两商人桶耗尽
    const three = sells.find((a) => a.sales.length === 3)!;
    const { state: after } = applySell(s, 0, three);
    for (const loc of ['stafford', 'walsall', 'derby'] as const) {
      expect(after.board.slots[loc]!.some((t) => t && t.player === 0 && t.flipped)).toBe(true);
    }
    expect(after.merchants.gloucester.barrels.filter(Boolean).length).toBe(0);
    expect(after.merchants.nottingham.barrels.filter(Boolean).length).toBe(0);
  });
});
