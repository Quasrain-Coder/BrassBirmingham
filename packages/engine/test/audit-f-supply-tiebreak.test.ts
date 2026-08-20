/**
 * 审计域 F 补充：煤源并列/链式取用、公共供应无限、原子性、市场满格售卖、
 * 双轨煤价串行递进（只读审计，不修改 src）。
 * 规则出处：规则书 p.8（txt 行 804-831 煤、881-901 铁；行 378-381 供应无限）、
 * p.9（行 1031-1063 建成即卖）；rules-reference §5、§9.1/9.7。
 * 预期：全部通过 = 合规；任何失败即确证 bug。
 */
import { describe, expect, it } from 'vitest';
import { applyBuild } from '../src/actions/build.js';
import { applyNetwork } from '../src/actions/network.js';
import type { Card } from '../src/data/cards.js';
import { tileDef } from '../src/data/tiles.js';
import { consumeCoal, consumeIron } from '../src/resources.js';
import { newGame, type GameState, type PlacedTile } from '../src/state.js';
import type { LocationId, PlayerIndex } from '../src/types.js';

const locCard = (location: LocationId): Card => ({
  id: `audit2-loc-${location}`,
  kind: 'location',
  location,
});

/** 手工铺 Link（linkIndex 0 基 = 规则参考 #N - 1）。 */
function withLink(s: GameState, linkIndex: number, player: PlayerIndex): void {
  s.board.links.push({ linkIndex, player, era: s.era });
}

/** 手工放板块（绕过建造校验）。 */
function withTile(
  s: GameState,
  player: PlayerIndex,
  loc: LocationId,
  slot: number,
  industry: 'coal' | 'iron' | 'brewery',
  resources: number,
): PlacedTile {
  const def = tileDef(industry, 1)!;
  const placed: PlacedTile = { tile: def, player, flipped: false, resources };
  s.board.slots[loc]![slot] = placed;
  return placed;
}

// 数值锚点：起始 £17 / 收入格 10；煤市场 14 格 filled 13（最便宜已填格 £1，
// 买 1 块后次便宜 £2）；coal L1 £5 放 2 块 income+4；brewery L1 income+4。

describe('⑤ 煤源：最近连通未翻面煤矿免费取、并列任选、耗尽取次近（R p.8 行 804-814）', () => {
  it('并列最近的任一玩家的矿都先于次近矿耗尽；引擎并列取字典序（规范化，符合"任选"）', () => {
    const s = newGame(4, 7);
    withLink(s, 3, 1); // #4 birmingham–dudley
    withLink(s, 2, 1); // #3 birmingham–coventry
    withLink(s, 26, 1); // #27 dudley–wolverhampton
    withTile(s, 1, 'coventry', 1, 'coal', 1); // 距离 1（并列，对手的矿也免费）
    withTile(s, 0, 'dudley', 0, 'coal', 1); // 距离 1（并列，自己的矿）
    withTile(s, 1, 'wolverhampton', 1, 'coal', 2); // 距离 2
    const { state, flipped } = consumeCoal(s, 0, 'birmingham', 3);
    // 两座距离 1 的矿必须都先于距离 2 的矿被取（并列内字典序 coventry → dudley）
    expect(flipped).toEqual([
      { kind: 'flip', player: 1, location: 'coventry', incomeAdvance: 4 },
      { kind: 'flip', player: 0, location: 'dudley', incomeAdvance: 4 },
    ]);
    expect(state.board.slots['wolverhampton']![1]!.resources).toBe(1); // 次近矿只出 1 块
    expect(state.board.slots['wolverhampton']![1]!.flipped).toBe(false);
    expect(state.players[1]!.incomeSpace).toBe(14); // 翻面收入归矿主
    expect(state.players[0]!.incomeSpace).toBe(14);
    expect(state.players[0]!.money).toBe(17); // 全程免费
    expect(state.coalMarket).toBe(13); // 未动市场
  });
});

describe('⑥ 公共供应无限：市场买空后可无限按兜底价购买（R p.4 行 378-381、p.8）', () => {
  it('煤市场为 0 时买 3 块 = 3×£8，市场计数停在 0（供应无上限）', () => {
    const s = newGame(4, 7);
    withLink(s, 35, 1); // #36 stoke-on-trent–warrington（连通商人位）
    s.coalMarket = 0;
    s.players[0]!.money = 30; // 兜底价 3×£8 超出开局 £17，先补足现金以隔离"供应无限"这一点
    const { state } = consumeCoal(s, 0, 'stoke-on-trent', 3);
    expect(state.players[0]!.money).toBe(30 - 24);
    expect(state.coalMarket).toBe(0);
  });

  it('铁市场为 0 时买 3 块 = 3×£6，无需任何连通（供应无上限）', () => {
    const s = newGame(4, 7); // 无 link 无板块
    s.ironMarket = 0;
    s.players[0]!.money = 30; // 同上：先补足现金
    const { state } = consumeIron(s, 0, 3);
    expect(state.players[0]!.money).toBe(30 - 18);
    expect(state.ironMarket).toBe(0);
  });
});

describe('②④ 市场买煤前置校验原子性：不连通商人位 → 整体拒绝，不产生部分消耗', () => {
  it('免费源 1 块、需 2 块但不连通商人位：抛 coal-not-connected 且入参毫发无损', () => {
    const s = newGame(4, 7);
    withTile(s, 1, 'cannock', 1, 'coal', 1); // 免费仅 1 块；cannock 无任何 link
    const snapshot = JSON.stringify(s);
    expect(() => consumeCoal(s, 0, 'cannock', 2)).toThrowError(/coal-not-connected/);
    expect(JSON.stringify(s)).toBe(snapshot); // 免费那块也不许被部分喝掉
  });
});

describe('⑦ 建成即卖：市场满格时 1 块也卖不出，方块全部留在板块上不翻面（R p.9 "as many as possible"）', () => {
  it('煤市场 14/14 满：连通商人位的煤矿建成卖 0 块、收 £0、留 2 块不翻面', () => {
    const s = newGame(4, 7);
    s.coalMarket = 14; // 满
    withLink(s, 20, 1); // #21 coalbrookdale–shrewsbury（对手铺的也算连通）
    s.players[0]!.hand = [locCard('coalbrookdale')];
    const { state, events } = applyBuild(s, 0, {
      type: 'build',
      cardId: 'audit2-loc-coalbrookdale',
      industry: 'coal',
      location: 'coalbrookdale',
    });
    const mine = state.board.slots['coalbrookdale']![2]!;
    expect(mine.resources).toBe(2); // 1 块也卖不出
    expect(mine.flipped).toBe(false);
    expect(state.coalMarket).toBe(14);
    expect(state.players[0]!.money).toBe(12); // 仅 £5 成本，无售卖收入
    expect(events.filter((e) => e.kind === 'flip')).toEqual([]);
  });
});

describe('② 枚举层：双轨两条铁路的煤在同一串行快照上结算，市场价逐格递进（R p.8 + p.11）', () => {
  it('第一条铁路买走最后 1 块 £1 煤后，第二条铁路按次便宜格 £2 付款', () => {
    const s = newGame(4, 7);
    s.era = 'rail';
    s.players[0]!.money = 20;
    // 对手已铺：stoke–stone、stone–uttoxeter；对手酒厂在 uttoxeter（供双轨啤酒）
    withLink(s, 34, 1); // #35 stoke-on-trent–stone
    withLink(s, 36, 1); // #37 stone–uttoxeter
    withTile(s, 1, 'uttoxeter', 0, 'brewery', 1);
    // 玩家 0 无板块无 Link（首建特例）：双轨 #36 stoke–warrington → #31 leek–stoke
    const cardId = s.players[0]!.hand[0]!.id;
    const next = applyNetwork(s, 0, { type: 'network', cardId, links: [35, 30] });
    // £15 双轨费 + 第 1 条煤 £1（filled 13 最便宜格）+ 第 2 条煤 £2（次便宜格）
    expect(next.players[0]!.money).toBe(20 - 15 - 1 - 2);
    expect(next.players[0]!.spentThisRound).toBe(15 + 1 + 2);
    expect(next.coalMarket).toBe(11); // 两条各买 1 块，市场串行递减
    // 双轨啤酒来自连通的对手酒厂：喝光翻面、收入归对手
    expect(next.board.slots['uttoxeter']![0]!.flipped).toBe(true);
    expect(next.players[1]!.incomeSpace).toBe(14);
    expect(next.lastEvents).toContainEqual({
      kind: 'flip',
      player: 1,
      location: 'uttoxeter',
      incomeAdvance: 4,
    });
  });
});
