/**
 * 审计域 F：市场与资源消耗（只读审计，不修改 src）。
 * 规则出处：规则书 p.4（设置步骤 7/8，txt 行 363-372）、p.8（txt 行 799-831 煤、
 * 877-901 铁）、p.9（txt 行 1031-1068 建成即卖市场）；rules-reference §5、§9.1/9.2/9.7/9.19。
 * 预期：本文件全部通过 = 该域实现合规；任何失败即确证 bug。
 */
import { describe, expect, it } from 'vitest';
import { enumerateBuilds, applyBuild } from '../src/actions/build.js';
import type { Card } from '../src/data/cards.js';
import { COAL_MARKET_PRICES, IRON_MARKET_PRICES } from '../src/data/market.js';
import { tileDef } from '../src/data/tiles.js';
import { buyCoalCost, buyIronCost } from '../src/market.js';
import { consumeCoal, consumeIron } from '../src/resources.js';
import { newGame, type GameState, type PlacedTile } from '../src/state.js';
import type { IndustryType, LocationId, PlayerIndex } from '../src/types.js';

const locCard = (location: LocationId): Card => ({
  id: `audit-loc-${location}`,
  kind: 'location',
  location,
});
const indCard = (industries: IndustryType[]): Card => ({
  id: `audit-ind-${industries.join('-')}`,
  kind: 'industry',
  industries,
});

function setHand(s: GameState, player: PlayerIndex, cards: Card[]): void {
  s.players[player]!.hand = cards;
}

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
  industry: 'coal' | 'iron',
  resources: number,
): PlacedTile {
  const def = tileDef(industry, 1)!;
  const placed: PlacedTile = { tile: def, player, flipped: false, resources };
  s.board.slots[loc]![slot] = placed;
  return placed;
}

// 数值锚点：起始 £17 / 收入格 10；煤市场 14 格 filled 13（空格 = 1 个 £1）；
// 铁市场 10 格 filled 8（空格 = 2 个 £1）。coal L1 £5 放 2 块 income+4；
// iron L1 £5+1 煤 放 4 块 income+3。

describe('① 市场格数与初始填充（R p.4 步骤 7/8；§5）', () => {
  it('煤 14 格 £1-£7 各 2；铁 10 格 £1-£5 各 2', () => {
    expect(COAL_MARKET_PRICES).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
    expect(IRON_MARKET_PRICES).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it('各人数开局：煤 13 块（留 1 个 £1 空）、铁 8 块（留 2 个 £1 空）', () => {
    for (const pc of [2, 3, 4] as const) {
      const s = newGame(pc, 7);
      expect(s.coalMarket).toBe(13);
      expect(s.ironMarket).toBe(8);
    }
  });
});

describe('② 买：最便宜格起逐格按格价；买空后煤 £8/铁 £6（R p.8；§5）', () => {
  it('煤逐格价序列：1, 1+2, 1+2+2, 1+2+2+3', () => {
    const s = newGame(4, 7);
    expect(buyCoalCost(s, 1)).toBe(1);
    expect(buyCoalCost(s, 2)).toBe(3);
    expect(buyCoalCost(s, 3)).toBe(5);
    expect(buyCoalCost(s, 4)).toBe(8);
  });

  it('铁逐格价序列（初始空格 £1×2，已填自 £2 起）：2, 2+2, 2+2+3', () => {
    const s = newGame(4, 7);
    expect(buyIronCost(s, 1)).toBe(2);
    expect(buyIronCost(s, 2)).toBe(4);
    expect(buyIronCost(s, 3)).toBe(7);
  });

  it('市场买逐格递减并计入本轮花费：consumeCoal 买 3 块 £5，煤市场 13→10', () => {
    const s = newGame(4, 7);
    withLink(s, 35, 1); // #36 stoke-on-trent–warrington（连通商人位）
    const { state } = consumeCoal(s, 0, 'stoke-on-trent', 3);
    expect(state.players[0]!.money).toBe(12); // 17 - (1+2+2)
    expect(state.players[0]!.spentThisRound).toBe(5);
    expect(state.coalMarket).toBe(10);
  });

  it('煤市场买空后 £8/块，公共供应无限（可继续买，市场计数停在 0）', () => {
    const s = newGame(4, 7);
    withLink(s, 35, 1);
    s.coalMarket = 0;
    const { state } = consumeCoal(s, 0, 'stoke-on-trent', 2);
    expect(state.players[0]!.money).toBe(1); // 17 - 2×8
    expect(state.coalMarket).toBe(0);
  });

  it('铁市场买空后 £6/块，且无需任何连通', () => {
    const s = newGame(4, 7); // 无 link 无板块
    s.ironMarket = 0;
    const { state } = consumeIron(s, 0, 2);
    expect(state.players[0]!.money).toBe(5); // 17 - 2×6
    expect(state.ironMarket).toBe(0);
  });
});

describe('④ 买煤连通：5 个商人位之一的图标，不要求该位有商人板块（R p.8；§9.2/9.19）', () => {
  it('2p 局 warrington/nottingham 无商人板块，仍是合法市场连通点', () => {
    const s = newGame(2, 7);
    expect(s.merchants.warrington.tiles).toEqual([]); // 2p 不放板块
    expect(s.merchants.nottingham.tiles).toEqual([]);
    withLink(s, 35, 1); // stoke-on-trent–warrington
    const r1 = consumeCoal(s, 0, 'stoke-on-trent', 1);
    expect(r1.state.coalMarket).toBe(12);
    expect(r1.state.players[0]!.money).toBe(16); // £1
    withLink(s, 23, 1); // derby–nottingham
    const r2 = consumeCoal(s, 0, 'derby', 1);
    expect(r2.state.coalMarket).toBe(12);
  });

  it('市场买空后兜底价购买仍须连通商人位：无连通抛 coal-not-connected', () => {
    const s = newGame(4, 7);
    s.coalMarket = 0;
    expect(() => consumeCoal(s, 0, 'dudley', 1)).toThrowError(/coal-not-connected/);
  });
});

describe('⑦ 建成即卖市场（仅当次行动）：煤矿须连通商人位、铁厂无条件（R p.9；§9.7）', () => {
  it('连通商人位的煤矿建成即卖：市场仅 1 个 £1 空格 → 卖 1 块收 £1，余 1 块不翻面', () => {
    const s = newGame(4, 7);
    withLink(s, 20, 1); // #21 coalbrookdale–shrewsbury（对手铺的也算连通）
    setHand(s, 0, [locCard('coalbrookdale')]);
    const { state } = applyBuild(s, 0, {
      type: 'build',
      cardId: 'audit-loc-coalbrookdale',
      industry: 'coal',
      location: 'coalbrookdale',
    });
    const mine = state.board.slots['coalbrookdale']![2]!;
    expect(mine.resources).toBe(1); // 放 2 块、卖 1 块
    expect(mine.flipped).toBe(false);
    expect(state.coalMarket).toBe(14);
    expect(state.players[0]!.money).toBe(13); // 17 - £5 + £1
    expect(state.players[0]!.spentThisRound).toBe(5); // 卖货收入不冲减本轮花费
  });

  it('不连通商人位的煤矿建成不卖：方块留在板块上，市场不动', () => {
    const s = newGame(4, 7); // 全图无 link
    setHand(s, 0, [locCard('dudley')]);
    const { state } = applyBuild(s, 0, {
      type: 'build',
      cardId: 'audit-loc-dudley',
      industry: 'coal',
      location: 'dudley',
    });
    expect(state.board.slots['dudley']![0]!.resources).toBe(2);
    expect(state.coalMarket).toBe(13);
    expect(state.players[0]!.money).toBe(12); // 仅 £5 成本
  });

  it('2p 局煤矿仅连通"无板块商人位"（warrington）也照常卖（R p.9 even those without Merchant tiles）', () => {
    const s = newGame(2, 7);
    expect(s.merchants.warrington.tiles).toEqual([]);
    withLink(s, 35, 1); // stoke-on-trent–warrington
    withLink(s, 30, 1); // leek–stoke-on-trent → leek 连通 warrington
    setHand(s, 0, [locCard('leek')]);
    const { state } = applyBuild(s, 0, {
      type: 'build',
      cardId: 'audit-loc-leek',
      industry: 'coal',
      location: 'leek',
    });
    expect(state.coalMarket).toBe(14); // 卖了 1 块（仅 1 个 £1 空格）
    expect(state.players[0]!.money).toBe(13);
  });

  it('铁厂建成无条件卖（全图无连通也卖）：4 块卖 2（£1×2 空格），余 2 不翻面', () => {
    const s = newGame(4, 7);
    // 对手在 coalbrookdale 放 1 座 2 块煤矿，供铁厂 1 块煤（距离 0 免费，无需连通）
    withTile(s, 1, 'coalbrookdale', 2, 'coal', 2);
    setHand(s, 0, [locCard('coalbrookdale')]);
    const { state } = applyBuild(s, 0, {
      type: 'build',
      cardId: 'audit-loc-coalbrookdale',
      industry: 'iron',
      location: 'coalbrookdale',
    });
    expect(state.board.slots['coalbrookdale']![2]!.resources).toBe(1); // 煤被喝 1 块
    const works = state.board.slots['coalbrookdale']![1]!;
    expect(works.resources).toBe(2); // 放 4 块、卖 2 块
    expect(works.flipped).toBe(false);
    expect(state.ironMarket).toBe(10);
    expect(state.players[0]!.money).toBe(14); // 17 - £5 + £2
  });

  it('铁厂卖空立即翻面并进收入（R p.9 步骤 3）', () => {
    const s = newGame(4, 7);
    withTile(s, 1, 'coalbrookdale', 2, 'coal', 2);
    s.ironMarket = 6; // 空格 £1×2+£2×2 → 最贵空格起 £2+£2+£1+£1 = £6，正好卖 4 块
    setHand(s, 0, [locCard('coalbrookdale')]);
    const { state } = applyBuild(s, 0, {
      type: 'build',
      cardId: 'audit-loc-coalbrookdale',
      industry: 'iron',
      location: 'coalbrookdale',
    });
    const works = state.board.slots['coalbrookdale']![1]!;
    expect(works.resources).toBe(0);
    expect(works.flipped).toBe(true);
    expect(state.players[0]!.incomeSpace).toBe(13); // 10 + 3
    expect(state.players[0]!.money).toBe(18); // 17 - £5 + £6
    expect(state.ironMarket).toBe(10);
  });

  it('方块只在建成当次行动卖：之后消耗煤矿方块不再触发售卖（R p.9 Note）', () => {
    const s = newGame(4, 7);
    setHand(s, 0, [locCard('dudley')]);
    const r1 = applyBuild(s, 0, {
      type: 'build',
      cardId: 'audit-loc-dudley',
      industry: 'coal',
      location: 'dudley',
    });
    // 之后的行动：在连通的 birmingham 建铁厂，喝自己 dudley 煤矿的煤（运河时代
    // 同地限 1 块己方板块，故换地点）。煤是被"消耗"而非"卖出"，煤市场必须保持不变
    withLink(r1.state as GameState, 3, 1); // #4 birmingham–dudley（对手铺的也算连通）
    const s2 = r1.state;
    s2.players[0]!.hand = [locCard('birmingham')];
    const r2 = applyBuild(s2, 0, {
      type: 'build',
      cardId: 'audit-loc-birmingham',
      industry: 'iron',
      location: 'birmingham',
    });
    expect(r2.state.board.slots['dudley']![0]!.resources).toBe(1); // 被铁厂喝 1 块
    expect(r2.state.coalMarket).toBe(13); // 绝无补卖
  });
});

describe('枚举层：耗煤建造的合法性预判与结算语义一致（§6.1/§9.2）', () => {
  const ironBuildsAt = (s: GameState, loc: LocationId) =>
    enumerateBuilds(s, 0).filter(
      (a) => a.type === 'build' && a.industry === 'iron' && a.location === loc,
    );

  it('无免费煤源且不连通商人位：枚不出任何铁厂建造（铁厂 £5+1 煤，市场买无路）', () => {
    const s = newGame(4, 7); // 无 link 无板块；首建特例下产业卡本来全图可建
    setHand(s, 0, [indCard(['iron'])]);
    const acts = enumerateBuilds(s, 0);
    expect(acts.filter((a) => a.type === 'build' && a.industry === 'iron')).toEqual([]);
  });

  it('连通商人位（任意玩家铺的边）→ 煤可市场买，铁厂建造被枚出（不多不漏）', () => {
    const s = newGame(4, 7);
    withLink(s, 35, 1); // stoke-on-trent–warrington（对手铺的）
    setHand(s, 0, [indCard(['iron'])]);
    expect(ironBuildsAt(s, 'stoke-on-trent')).toHaveLength(1); // £5+£1 ≤ £17
    expect(ironBuildsAt(s, 'dudley')).toEqual([]); // 不连通商人位，不可枚
  });

  it('有免费连通煤源（距离 0 的同地煤矿）时无需商人连通即可枚出耗煤建造', () => {
    const s = newGame(4, 7);
    withTile(s, 1, 'dudley', 0, 'coal', 2); // 对手的煤矿；自己无板块无 Link（首建特例全图可建）
    setHand(s, 0, [indCard(['iron'])]);
    expect(ironBuildsAt(s, 'dudley')).toHaveLength(1); // 煤免费取自同地煤矿
    expect(ironBuildsAt(s, 'birmingham')).toEqual([]); // 无煤源且无商人连通，不可枚
  });
});
