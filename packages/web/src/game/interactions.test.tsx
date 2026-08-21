/**
 * resolveBuildSlot 与引擎 resolveSlot 一致性的关键场景测试:
 * 单图标槽优先于双图标槽(规则书 p.9);空槽占用顺序;与 applyAction 实际落槽一致。
 */
import { describe, expect, it } from 'vitest';
import { applyAction, enumerateActions, newGame, tileDef } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import type { FilteredState } from '@brass/protocol';
import { resolveBuildSlot } from './interactions';

function freshState(): FilteredState {
  return filterStateFor(newGame(4, 42), 0);
}

describe('resolveBuildSlot', () => {
  it('Birmingham 制造厂:槽 0(棉/制造双图标)与槽 1/3(制造单图标)都空时,落首个单图标槽 1', () => {
    const s = freshState();
    expect(resolveBuildSlot(s, 0, 'birmingham', 'manufacturer', 1)).toEqual({
      location: 'birmingham',
      slotIndex: 1,
    });
  });

  it('单图标槽被占后,才落双图标槽(Birmingham 槽 1/3 被占 → 槽 0)', () => {
    const s = freshState();
    const manu = tileDef('manufacturer', 1)!;
    s.board.slots['birmingham']![1] = { tile: manu, player: 1, flipped: false, resources: 0 };
    s.board.slots['birmingham']![3] = { tile: manu, player: 1, flipped: false, resources: 0 };
    s.era = 'rail'; // 避开运河时代每城限 1 块(本场景测空槽优先级)
    expect(resolveBuildSlot(s, 0, 'birmingham', 'manufacturer', 2)).toEqual({
      location: 'birmingham',
      slotIndex: 0,
    });
  });

  it('与引擎实际结算一致:applyAction 后板块落在同一槽位', () => {
    // 用完整 GameState(applyAction 需要 deck/discard),resolveBuildSlot 只读公开字段
    const s = newGame(4, 42);
    const coal = tileDef('coal', 1)!;
    s.board.slots['dudley']![0] = { tile: coal, player: 1, flipped: false, resources: 3 };
    s.board.links.push({ linkIndex: 3, player: 1, era: 'canal' });
    s.players[0]!.hand = [{ id: 'c1', kind: 'location', location: 'birmingham' }];
    s.currentPlayerIdx = s.turnOrder.indexOf(0);
    const build = enumerateActions(s, 0).find(
      (a) => a.type === 'build' && a.industry === 'manufacturer' && a.location === 'birmingham',
    )!;
    const target = resolveBuildSlot(s as never, 0, 'birmingham', 'manufacturer', 1)!;
    const after = applyAction(s, build);
    const placedAt = after.board.slots['birmingham']!.findIndex(
      (t) => t !== null && t.player === 0,
    );
    expect(placedAt).toBe(target.slotIndex);
  });

  it('对手煤矿全图零方块时,优先 overbuild 对手(规范化的非支配选择)', () => {
    const s = freshState();
    const coal = tileDef('coal', 1)!;
    const coal2 = tileDef('coal', 2)!;
    // 清空煤市场与全场煤块(本 fixture 本来就没有;玩家0面板上拿 2 级煤)
    s.coalMarket = 0;
    // 对手在 cannock 有 1 级煤矿(全图唯一煤块也清空)
    s.board.slots['cannock']![1] = { tile: coal, player: 1, flipped: false, resources: 0 };
    // 玩家 0 面板只留 2 级煤(让最低级 = 2 级,可 overbuild 1 级)
    s.players[0]!.tiles = s.players[0]!.tiles.filter((t) => t !== coal2 || t.industry !== 'coal' ? t.industry !== 'coal' || t.level >= 2 : false);
    s.players[0]!.hand = [{ id: 'c1', kind: 'industry', industries: ['coal'] }];
    // 玩家 0 在 cannock 有板块?不能有(运河时代同地限 1 块会禁对手覆盖)——改铁路时代
    s.era = 'rail';
    const target = resolveBuildSlot(s, 0, 'cannock', 'coal', 2);
    expect(target).toEqual({ location: 'cannock', slotIndex: 1 }); // overbuild 对手的槽 1,而非空槽 0
  });
});
