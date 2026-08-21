/**
 * interactions 纯函数测试（M2 Task 11 Step 1）。
 * 部分用例用 engine newGame + enumerateActions 真实枚举做 fixture（验证对枚举形态的假设：
 * scout i<j<k、develop removals 规范化序、network 双轨有序对），其余用手搓 Action 数据。
 * 关键不变量：匹配函数一律返回入参数组里的**同一个对象**（toBe），绝不新构造。
 */
import { describe, expect, it } from 'vitest';
import { enumerateActions, newGame } from '@brass/engine';
import type { Action, Card, GameState, IndustryType } from '@brass/engine';
import {
  actionsForCard,
  buildCandidatesAt,
  buildSlotTargets,
  describeAction,
  developOptions,
  extendableLinks,
  matchDevelop,
  matchNetwork,
  matchScout,
  normalizeRemovals,
  sellCandidatesAt,
  sellOptions,
  sellSlotTargets,
  targetsFor,
} from './interactions';

type NetworkAction = Extract<Action, { type: 'network' }>;
type DevelopAction = Extract<Action, { type: 'develop' }>;
type SellAction = Extract<Action, { type: 'sell' }>;

function freshGame(): { state: GameState; legal: Action[]; hand: Card[] } {
  const state = newGame(4, 42);
  return { state, legal: enumerateActions(state, 0), hand: state.players[0]!.hand };
}

const net = (links: number[], cardId = 'c1'): NetworkAction => ({
  type: 'network',
  cardId,
  links,
});
const dev = (removals: IndustryType[], cardId = 'c1'): DevelopAction => ({
  type: 'develop',
  cardId,
  removals,
});
const sell1 = (location: string, slotIndex: number, cardId = 'c1'): SellAction => ({
  type: 'sell',
  cardId,
  sales: [{ location, slotIndex, merchant: 'oxford', useMerchantBeer: false }],
});

describe('actionsForCard', () => {
  it('按 cardId 过滤普通行动', () => {
    const actions: Action[] = [
      { type: 'loan', cardId: 'a' },
      { type: 'pass', cardId: 'b' },
      { type: 'pass', cardId: 'a' },
    ];
    expect(actionsForCard(actions, 'a')).toEqual([actions[0], actions[2]]);
  });

  it('scout 行动按 cardIds 包含匹配（无 cardId 字段）', () => {
    const scout: Action = { type: 'scout', cardIds: ['a', 'b', 'c'] };
    expect(actionsForCard([scout], 'b')).toEqual([scout]);
    expect(actionsForCard([scout], 'd')).toEqual([]);
  });
});

describe('targetsFor', () => {
  it('selectedCard 为 null 时返回空目标', () => {
    const t = targetsFor(null, [{ type: 'pass', cardId: 'a' }]);
    expect(t.locations.size).toBe(0);
    expect(t.links.size).toBe(0);
    expect(t.industries.size).toBe(0);
  });

  it('location 卡：该城市进入 locations 与 industries', () => {
    const { legal, hand } = freshGame();
    const card = hand.find((c) => c.kind === 'location');
    expect(card).toBeDefined();
    if (card?.kind !== 'location') return;
    const t = targetsFor(card.id, legal);
    expect(t.locations.has(card.location)).toBe(true);
    expect((t.industries.get(card.location) ?? []).length).toBeGreaterThan(0);
  });

  it('industry 卡：build 目标覆盖多个城市且产业含卡面产业', () => {
    const { legal, hand } = freshGame();
    // 并非每张产业卡开局都有合法 build（如煤/铁厂需连通买资源），找一张有目标的
    const card = hand.find(
      (c) => c.kind === 'industry' && targetsFor(c.id, legal).locations.size > 1,
    );
    expect(card).toBeDefined();
    if (card?.kind !== 'industry') return;
    const t = targetsFor(card.id, legal);
    const allIndustries = [...t.industries.values()].flat();
    for (const ind of card.industries) {
      expect(allIndustries).toContain(ind);
    }
  });

  it('network 行动 → links 集合（摊平所有候选的边）', () => {
    const t = targetsFor('c1', [net([3]), net([5, 7])]);
    expect([...t.links].sort((a, b) => a - b)).toEqual([3, 5, 7]);
  });

  it('sell 行动 → 板块所在城市进入 locations', () => {
    const t = targetsFor('c1', [sell1('birmingham', 0)]);
    expect(t.locations.has('birmingham')).toBe(true);
  });
});

describe('buildSlotTargets / sellSlotTargets', () => {
  it('build 目标展开到空槽位；已占用槽位不高亮', () => {
    const { state, legal, hand } = freshGame();
    const card = hand.find((c) => c.kind === 'location');
    if (card?.kind !== 'location') throw new Error('fixture 缺 location 卡');
    const t = targetsFor(card.id, legal);
    const refs = buildSlotTargets(t, state.board.slots);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect(r.location).toBe(card.location);
      expect(state.board.slots[r.location]?.[r.slotIndex]).toBeNull();
    }
    // 占用一个匹配槽位后不再高亮该槽
    const first = refs[0]!;
    state.board.slots[first.location]![first.slotIndex] = {
      tile: { industry: 'coal' } as never,
      player: 1,
      flipped: false,
      resources: 0,
    };
    const refs2 = buildSlotTargets(t, state.board.slots);
    expect(refs2).toHaveLength(refs.length - 1);
    expect(refs2).not.toContainEqual(first);
  });

  it('sell 高亮槽位直接取 sales 的 (location, slotIndex)', () => {
    const refs = sellSlotTargets([sell1('birmingham', 1), sell1('coventry', 0)]);
    expect(refs).toContainEqual({ location: 'birmingham', slotIndex: 1 });
    expect(refs).toContainEqual({ location: 'coventry', slotIndex: 0 });
  });
});

describe('buildCandidatesAt / sellCandidatesAt', () => {
  it('槽位印刷产业匹配 build 候选；同槽多产业返回多个供用户选', () => {
    const builds: Action[] = [
      { type: 'build', cardId: 'c1', industry: 'cotton', location: 'birmingham' },
      { type: 'build', cardId: 'c1', industry: 'manufacturer', location: 'birmingham' },
      { type: 'build', cardId: 'c1', industry: 'iron', location: 'birmingham' },
    ];
    // birmingham 槽位 0 印 cotton+manufacturer（见 board 数据），不印 iron
    const hits = buildCandidatesAt(builds, 'birmingham', 0);
    expect(hits.map((a) => (a.type === 'build' ? a.industry : '')).sort()).toEqual([
      'cotton',
      'manufacturer',
    ]);
  });

  it('sell 按 (location, slotIndex) 过滤单卖候选', () => {
    const sells: Action[] = [sell1('birmingham', 0), sell1('birmingham', 1)];
    expect(sellCandidatesAt(sells, 'birmingham', 1)).toEqual([sells[1]]);
  });
});

describe('matchNetwork / extendableLinks', () => {
  const candidates: Action[] = [net([3]), net([5, 7]), net([5, 9]), net([7, 5])];

  it('空序列：valid，无 exact，可点所有首边', () => {
    const m = matchNetwork(candidates, []);
    expect(m.valid).toBe(true);
    expect(m.exact).toBeNull();
    expect(m.canExtend).toBe(true);
    expect([...extendableLinks(candidates, [])].sort((a, b) => a - b)).toEqual([3, 5, 7]);
  });

  it('点 [3]：精确命中单条且不可延长', () => {
    const m = matchNetwork(candidates, [3]);
    expect(m.exact).toBe(candidates[0]); // 同一对象，非新构造
    expect(m.canExtend).toBe(false);
  });

  it('点 [5]：无可提交（只有双条），可延长 7/9', () => {
    const m = matchNetwork(candidates, [5]);
    expect(m.exact).toBeNull();
    expect(m.canExtend).toBe(true);
    expect([...extendableLinks(candidates, [5])].sort((a, b) => a - b)).toEqual([7, 9]);
  });

  it('点 [5,7]：精确命中有序对；[7,5] 是不同行动', () => {
    expect(matchNetwork(candidates, [5, 7]).exact).toBe(candidates[1]);
    expect(matchNetwork(candidates, [7, 5]).exact).toBe(candidates[3]);
  });

  it('非任何候选前缀 → invalid', () => {
    const m = matchNetwork(candidates, [9]);
    expect(m.valid).toBe(false);
    expect(m.exact).toBeNull();
  });

  it('非 network 候选被忽略', () => {
    const m = matchNetwork([{ type: 'pass', cardId: 'c1' }, net([1])], [1]);
    expect(m.exact).not.toBeNull();
  });
});

describe('develop', () => {
  it('developOptions 取所有候选出现过的产业（按规范化序）', () => {
    const opts = developOptions([dev(['iron']), dev(['cotton', 'iron']), dev(['coal'])]);
    expect(opts).toEqual(['cotton', 'coal', 'iron']);
  });

  it('normalizeRemovals 按产业规范化序排序，同产业双块保留', () => {
    expect(normalizeRemovals(['iron', 'cotton'])).toEqual(['cotton', 'iron']);
    expect(normalizeRemovals(['coal', 'coal'])).toEqual(['coal', 'coal']);
  });

  it('matchDevelop 乱序选择仍命中规范化 removals（同一对象）', () => {
    const candidates: Action[] = [dev(['cotton']), dev(['cotton', 'iron'])];
    expect(matchDevelop(candidates, ['iron', 'cotton'])).toBe(candidates[1]);
    expect(matchDevelop(candidates, ['cotton'])).toBe(candidates[0]);
    expect(matchDevelop(candidates, ['iron'])).toBeNull();
  });

  it('真实枚举：removals 已按规范化序，matchDevelop 命中枚举项本身', () => {
    const { legal, hand } = freshGame();
    const develops = legal.filter((a): a is DevelopAction => a.type === 'develop');
    expect(develops.length).toBeGreaterThan(0);
    const two = develops.find((a) => a.removals.length === 2);
    if (two !== undefined) {
      const reversed = [...two.removals].reverse();
      expect(matchDevelop(actionsForCard(legal, two.cardId), reversed)).toBe(two);
    }
    const one = develops[0]!;
    expect(hand.some((c) => c.id === one.cardId)).toBe(true);
  });
});

describe('sellOptions', () => {
  it('单卖与多块全集分离；全集是 sales.length>=2 的唯一行动', () => {
    const full: SellAction = {
      type: 'sell',
      cardId: 'c1',
      sales: [
        { location: 'birmingham', slotIndex: 0, merchant: 'oxford', useMerchantBeer: false },
        { location: 'coventry', slotIndex: 1, merchant: 'oxford', useMerchantBeer: true },
      ],
    };
    const opts = sellOptions([sell1('birmingham', 0), sell1('coventry', 1), full]);
    expect(opts.singles).toHaveLength(2);
    expect(opts.fullSet).toBe(full);
  });

  it('无多块枚举时 fullSet 为 null', () => {
    expect(sellOptions([sell1('birmingham', 0)]).fullSet).toBeNull();
    expect(sellOptions([]).singles).toEqual([]);
  });
});

describe('matchScout', () => {
  it('任意顺序选 3 张 → 按手牌序排序命中 i<j<k 枚举项本身', () => {
    const { legal, hand } = freshGame();
    const scouts = legal.filter((a) => a.type === 'scout');
    expect(scouts.length).toBeGreaterThan(0); // 开局无 wild、供应满，scout 恒可枚举
    // 选手牌下标 0/2/5，乱序给入
    const picks = [hand[5]!.id, hand[0]!.id, hand[2]!.id];
    const hit = matchScout(legal, hand, picks);
    expect(hit).not.toBeNull();
    expect(hit?.type).toBe('scout');
    if (hit?.type !== 'scout') return;
    expect(hit.cardIds).toEqual([hand[0]!.id, hand[2]!.id, hand[5]!.id]);
    expect(scouts).toContain(hit); // 枚举项本身
  });

  it('不足 3 张或有牌不在手牌中 → null', () => {
    const { legal, hand } = freshGame();
    expect(matchScout(legal, hand, [hand[0]!.id, hand[1]!.id])).toBeNull();
    expect(matchScout(legal, hand, [hand[0]!.id, hand[1]!.id, 'nope'])).toBeNull();
  });
});

describe('describeAction', () => {
  it('各行动类型产出非空描述', () => {
    const cases: Action[] = [
      { type: 'build', cardId: 'c', industry: 'cotton', location: 'birmingham' },
      net([0, 1]),
      dev(['iron']),
      sell1('birmingham', 0),
      { type: 'loan', cardId: 'c' },
      { type: 'scout', cardIds: ['a', 'b', 'c'] },
      { type: 'pass', cardId: 'c' },
    ];
    for (const a of cases) {
      expect(describeAction(a).length).toBeGreaterThan(0);
    }
    expect(describeAction(cases[0]!)).toContain('伯明翰');
  });
});

describe('buildabilityFor(面板可建性标注)', () => {
  it('开局:有合法建造的产业标 ✓,其余给原因;现金不足标 还需 £N', async () => {
    const { buildabilityFor } = await import('./interactions');
    const { filterStateFor } = await import('@brass/protocol');
    const game = newGame(4, 42);
    const seat = game.turnOrder[game.currentPlayerIdx]!;
    const state = filterStateFor(game, seat);
    const legal = enumerateActions(game, seat);
    const status = buildabilityFor(state, seat, legal);
    // 全产业都有标注
    expect(Object.keys(status).sort()).toEqual(
      ['brewery', 'coal', 'cotton', 'iron', 'manufacturer', 'pottery'].sort(),
    );
    // 有合法 build 的产业 → ✓ 可建造
    const buildable = new Set(
      legal.filter((a) => a.type === 'build').map((a) => (a as { industry: IndustryType }).industry),
    );
    for (const ind of buildable) expect(status[ind]).toBe('✓ 可建造');
    // 现金压到 0 → 非可建产业全部 还需 £N
    state.players[seat]!.money = 0;
    const broke = buildabilityFor(state, seat, []);
    expect(broke['cotton']).toMatch(/^还需 £\d+$/);
  });

  it('板块用尽:该产业标 板块已用尽', async () => {
    const { buildabilityFor } = await import('./interactions');
    const { filterStateFor } = await import('@brass/protocol');
    const game = newGame(4, 42);
    const seat = game.turnOrder[game.currentPlayerIdx]!;
    const state = filterStateFor(game, seat);
    state.players[seat]!.tiles = state.players[seat]!.tiles.filter((t) => t.industry !== 'coal');
    expect(buildabilityFor(state, seat, [])['coal']).toBe('板块已用尽');
  });
});

describe('reconstructEraLog(行动日志补全)', () => {
  it('按回合结构交错还原:运河首轮各 1 动,其后各 2 动', async () => {
    const { reconstructEraLog } = await import('./interactions');
    const { filterStateFor } = await import('@brass/protocol');
    const state = filterStateFor(newGame(4, 42), 0);
    const order = state.turnOrder;
    const mk = (id: string): Action => ({ type: 'pass', cardId: id });
    // 首轮每座位 1 条,次轮每座位 2 条(按座位号入桶)
    const eraActions: Action[][] = [];
    order.forEach((seat) => {
      eraActions[seat] = [mk(`r1-${seat}`), mk(`r2a-${seat}`), mk(`r2b-${seat}`)];
    });
    const out = reconstructEraLog(state, eraActions);
    expect(out.map((e) => e.player)).toEqual([
      order[0], order[1], order[2], order[3], // 首轮轮转
      order[0], order[0], order[1], order[1], order[2], order[2], order[3], order[3], // 次轮各 2 动
    ]);
    expect(out.map((e) => (e.action as { cardId: string }).cardId)).toEqual([
      `r1-${order[0]}`, `r1-${order[1]}`, `r1-${order[2]}`, `r1-${order[3]}`,
      `r2a-${order[0]}`, `r2b-${order[0]}`, `r2a-${order[1]}`, `r2b-${order[1]}`,
      `r2a-${order[2]}`, `r2b-${order[2]}`, `r2a-${order[3]}`, `r2b-${order[3]}`,
    ]);
  });

  it('残缺尾部(当前轮进行中)也能正确截断', async () => {
    const { reconstructEraLog } = await import('./interactions');
    const { filterStateFor } = await import('@brass/protocol');
    const state = filterStateFor(newGame(4, 42), 0);
    const order = state.turnOrder;
    const mk = (id: string): Action => ({ type: 'pass', cardId: id });
    const eraActions: Action[][] = [];
    order.forEach((seat, i) => {
      eraActions[seat] = i === 0 ? [mk(`r1-${seat}`), mk(`r2-${seat}`)] : [mk(`r1-${seat}`)];
    });
    const out = reconstructEraLog(state, eraActions);
    expect(out.map((e) => (e.action as { cardId: string }).cardId)).toEqual([
      `r1-${order[0]}`, `r1-${order[1]}`, `r1-${order[2]}`, `r1-${order[3]}`, `r2-${order[0]}`,
    ]);
  });
});
