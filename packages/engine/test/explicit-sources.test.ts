/**
 * 显式资源来源（煤/铁/商人桶 tileIndex / 覆盖槽位自选）回归测试。
 * 2026-08-26 跨引擎对拍（brass-assistant 轨迹重放）驱动的规则自由选择补齐：
 * - 商人桶 tileIndex：同商人多格收该产业时桶位任选；规范化默认精确图标格优先
 *   （修复：牛津[制造,万能]格局下"制造→陶"两连卖被最右桶规范化卡死）。
 * - build coalSources/ironSources：并列任选的煤/铁来源显式指定。
 * - build slotIndex：多个可覆盖目标时覆盖槽位自选。
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applySell,
  consumeCoal,
  consumeIron,
  enumerateActions,
  newGame,
  type GameState,
  type PlayerIndex,
} from '../src/index.js';
import { IllegalActionError } from '../src/errors.js';

/** 在指定地点槽位放一块板块（测试辅助，直接改 state）。 */
function place(
  s: GameState,
  player: PlayerIndex,
  location: string,
  slotIndex: number,
  industry: 'cotton' | 'manufacturer' | 'pottery' | 'coal' | 'iron' | 'brewery',
  opts: { flipped?: boolean; resources?: number } = {},
): void {
  const def = s.players[player]!.tiles.find((t) => t.industry === industry)!;
  s.board.slots[location]![slotIndex] = {
    tile: def,
    player,
    flipped: opts.flipped ?? false,
    resources: opts.resources ?? def.resourcesPlaced,
  };
}

describe('商人桶规范化：精确图标格优先', () => {
  it('牛津[制造(桶),万能(桶)]格局下，制造+陶两连卖合法（旧最右规范化会卡死）', () => {
    const s = newGame(4, 7);
    // 手工布置：牛津 = [制造(桶), 万能(桶)]；P0 在考文垂有制造厂 L1、陶瓷厂 L1
    s.merchants.oxford = { tiles: ['manufacturer', 'any'], barrels: [true, true] };
    place(s, 0, 'coventry', 1, 'manufacturer'); // slot1 = manufacturer/coal
    place(s, 0, 'coventry', 0, 'pottery');
    // 连通考文垂↔牛津：birmingham–oxford + birmingham–coventry
    s.board.links.push({ linkIndex: 5, player: 0, era: 'canal' });
    s.board.links.push({ linkIndex: 2, player: 0, era: 'canal' });
    const cardId = s.players[0]!.hand[0]!.id;
    // 两连卖：制造用精确桶、陶用万能桶——旧规范化（最右=万能先扣）下陶无桶可卖
    const r = applySell(s, 0, {
      type: 'sell',
      cardId,
      sales: [
        { location: 'coventry', slotIndex: 1, merchant: 'oxford', useMerchantBeer: true },
        { location: 'coventry', slotIndex: 0, merchant: 'oxford', useMerchantBeer: true },
      ],
    });
    expect(r.state.board.slots['coventry']![0]!.flipped).toBe(true);
    expect(r.state.board.slots['coventry']![1]!.flipped).toBe(true);
    expect(r.state.merchants.oxford.barrels).toEqual([false, false]);
  });

  it('显式 tileIndex 覆盖规范化：可指定万能格而非精确格', () => {
    const s = newGame(4, 7);
    s.merchants.oxford = { tiles: ['manufacturer', 'any'], barrels: [true, true] };
    place(s, 0, 'coventry', 1, 'manufacturer');
    s.board.links.push({ linkIndex: 5, player: 0, era: 'canal' });
    s.board.links.push({ linkIndex: 2, player: 0, era: 'canal' });
    const r = applySell(s, 0, {
      type: 'sell',
      cardId: s.players[0]!.hand[0]!.id,
      sales: [
        {
          location: 'coventry',
          slotIndex: 1,
          merchant: 'oxford',
          useMerchantBeer: true,
          beerSources: [{ kind: 'merchant', tileIndex: 1 }], // 显式用万能格
        },
      ],
    });
    expect(r.state.merchants.oxford.barrels).toEqual([true, false]);
    // 非法 tileIndex（格上无桶/不收该产业）抛错
    expect(() =>
      applySell(s, 0, {
        type: 'sell',
        cardId: s.players[0]!.hand[0]!.id,
        sales: [
          {
            location: 'coventry',
            slotIndex: 1,
            merchant: 'oxford',
            useMerchantBeer: true,
            beerSources: [{ kind: 'merchant', tileIndex: 0 }].map(() => ({ kind: 'merchant' as const, tileIndex: 5 })),
          },
        ],
      }),
    ).toThrow(IllegalActionError);
  });
});

describe('显式煤/铁来源', () => {
  it('build coalSources：指定取自己的矿（耗尽翻面进收入）而非规范化最近矿', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    // P0 在坎诺克有 L2 煤矿（3 块,余 1），在达德利有 L1 煤矿（2 块,余 2）
    const l2 = s.players[0]!.tiles.find((t) => t.industry === 'coal' && t.level === 2)!;
    s.board.slots['cannock']![1] = { tile: l2, player: 0, flipped: false, resources: 1 };
    place(s, 0, 'dudley', 0, 'coal', { resources: 2 });
    // 连通链：birmingham–walsall–cannock（伯明翰建铁厂 L1 耗 1 煤可及坎诺克）
    s.board.links.push({ linkIndex: 8, player: 0, era: 'rail' }); // birmingham–walsall
    s.board.links.push({ linkIndex: 17, player: 0, era: 'rail' }); // cannock–walsall
    s.players[0]!.hand = [{ id: 'test-bham', kind: 'location', location: 'birmingham' }];
    // 栈顶推进到 L2（L1 铁路时代禁建）
    s.players[0]!.tiles = s.players[0]!.tiles.filter(
      (t) => t.industry !== 'iron' || t.level >= 2,
    );
    const incomeBefore = s.players[0]!.incomeSpace;
    const next = applyAction(s, {
      type: 'build',
      cardId: 'test-bham',
      industry: 'iron',
      location: 'birmingham',
      coalSources: [{ location: 'cannock', slotIndex: 1, count: 1 }],
    });
    // 坎诺克矿被取空 → 翻面 → P0 收入 +7（coal L2 incomeAdvance）
    expect(next.board.slots['cannock']![1]!.flipped).toBe(true);
    expect(next.players[0]!.incomeSpace).toBe(incomeBefore + 7);
    // 达德利矿未被碰
    expect(next.board.slots['dudley']![0]!.resources).toBe(2);
  });

  it('consumeCoal 显式来源：不连通的矿 / 超量提供均抛错', () => {
    const s = newGame(4, 7);
    place(s, 0, 'dudley', 0, 'coal', { resources: 2 });
    // dudley 不连通 birmingham → 非法
    expect(() =>
      consumeCoal(s, 0, 'birmingham', 1, {
        explicit: [{ location: 'dudley', slotIndex: 0, count: 1 }],
      }),
    ).toThrow(IllegalActionError);
    expect(() =>
      consumeIron(s, 0, 1, {
        explicit: [{ location: 'dudley', slotIndex: 0, count: 2 }],
      }),
    ).toThrow(IllegalActionError); // 提供 2 > 需求 1
  });
});

describe('覆盖槽位自选', () => {
  it('同地两块己方低级煤矿，可显式选择覆盖等级较高的那块（规范化取最低级）', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    // 坎诺克：slot0 己方 L3（已翻面）、slot1 己方 L2（已翻面）——规范化会覆盖 L2
    place(s, 0, 'cannock', 0, 'coal', { flipped: true, resources: 0 });
    // 手动换成 L3：直接构造
    const l3 = s.players[0]!.tiles.find((t) => t.industry === 'coal' && t.level === 3)!;
    s.board.slots['cannock']![0] = { tile: l3, player: 0, flipped: true, resources: 0 };
    const l2 = s.players[0]!.tiles.find((t) => t.industry === 'coal' && t.level === 2)!;
    s.board.slots['cannock']![1] = { tile: l2, player: 0, flipped: true, resources: 0 };
    // P0 面板移除 L1/L2/L3 使栈顶为 L4
    s.players[0]!.tiles = s.players[0]!.tiles.filter(
      (t) => t.industry !== 'coal' || t.level >= 4,
    );
    const cardId = s.players[0]!.hand.find((c) => c.kind === 'industry' && c.industries.includes('coal'))?.id
      ?? s.players[0]!.hand[0]!.id;
    const next = applyAction(s, {
      type: 'build',
      cardId,
      industry: 'coal',
      location: 'cannock',
      slotIndex: 0, // 显式覆盖 L3 而非规范化的 L2
    });
    expect(next.board.slots['cannock']![0]!.tile.level).toBe(4);
    expect(next.board.slots['cannock']![1]!.tile.level).toBe(2);
  });
});
