/**
 * 时代末分数构成计算测试:与引擎 era.ts 计分算法一致性(Link 连接图标 + 翻面产业 VP)。
 */
import { describe, expect, it } from 'vitest';
import { newGame, tileDef } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import { computeEraBreakdown } from './ScoreTable';

describe('computeEraBreakdown', () => {
  it('Link 分只数两端相邻地点的已翻面板块连接图标;产业分 = 已翻面板块 VP 总和', () => {
    const s = filterStateFor(newGame(4, 42), 0);
    const cotton1 = tileDef('cotton', 1)!; // vp5 linkIcons1
    const iron1 = tileDef('iron', 1)!; // vp3 linkIcons1
    const coal1 = tileDef('coal', 1)!; // vp1 linkIcons2
    // 玩家 0:birmingham 棉 I(翻面)+ dudley 铁 I(未翻面);玩家 1:dudley 煤 I(翻面)
    s.board.slots['birmingham']![0] = { tile: cotton1, player: 0, flipped: true, resources: 0 };
    s.board.slots['dudley']![1] = { tile: iron1, player: 0, flipped: false, resources: 4 };
    s.board.slots['dudley']![0] = { tile: coal1, player: 1, flipped: true, resources: 0 };
    // 玩家 0 的 Link:#4 birmingham-dudley;玩家 1 的 Link:#3 birmingham-coventry(两端无翻面)
    s.board.links.push({ linkIndex: 3, player: 0, era: 'canal' });
    s.board.links.push({ linkIndex: 2, player: 1, era: 'canal' });

    const b = computeEraBreakdown(s);
    // 玩家 0:link 分 = birmingham 棉 I 1 图标 + dudley(铁 I 未翻面 0 + 煤 I 2 图标,煤是玩家1的也计入!) 
    // 规则:两端相邻地点内所有已翻面板块(不分归属)的连接图标
    expect(b.get(0)!.linkVp).toBe(1 + 2);
    expect(b.get(0)!.industryVp).toBe(5); // 棉 I vp5;铁 I 未翻面不计
    // 玩家 1:link 分 0(coventry 无板块、birmingham 棉 I 是玩家0的——规则上看两端图标不分归属? 
    // 不:玩家1的 Link #3 两端 birmingham-coventry,birmingham 有已翻面棉 I(玩家0)→ 按规则也计 1 图标
    expect(b.get(1)!.linkVp).toBe(1);
    expect(b.get(1)!.industryVp).toBe(1); // 煤 I vp1
  });

  it('三端点边(#30 kidderminster-worcester 含 farm-south)的农场端点图标计入', () => {
    const s = filterStateFor(newGame(4, 42), 0);
    const brewery1 = tileDef('brewery', 1)!; // vp4 linkIcons2
    s.board.slots['farm-south']![0] = { tile: brewery1, player: 2, flipped: true, resources: 0 };
    s.board.links.push({ linkIndex: 29, player: 0, era: 'canal' });
    const b = computeEraBreakdown(s);
    expect(b.get(0)!.linkVp).toBe(2); // farm-south 已翻面酒厂 2 图标(归属不影响)
    expect(b.get(2)!.industryVp).toBe(4);
  });
});
