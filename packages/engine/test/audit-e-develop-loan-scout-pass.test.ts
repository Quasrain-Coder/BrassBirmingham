/**
 * 审计域 E：Develop / Loan / Scout / Pass（只读规则审计，不修改 src）。
 * 规则依据：规则书 p.11（Develop/Loan/Scout）、p.6（Scout/Pass）、p.8（Consuming Iron）；
 * rules-reference §6.4/6.6/6.7/6.8、§9.14（Wild 弃置归还）。
 */
import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { applyAction, enumerateActions } from '../src/apply.js';
import { enumerateDevelop, applyDevelop } from '../src/actions/develop.js';
import { applyScout } from '../src/actions/scout.js';
import { LOCATIONS } from '../src/data/board.js';
import { tileDef } from '../src/data/tiles.js';
import type { LocationId, PlayerIndex } from '../src/types.js';
import type { Card } from '../src/data/cards.js';

/** 当前行动玩家。 */
function currentPlayer(s: GameState): PlayerIndex {
  return s.turnOrder[s.currentPlayerIdx]!;
}

/** 在首个有 iron 空槽的地点放一块铁厂（与 actions.test.ts 的 withTile 同法，直接改 slots）。 */
function withIronWorks(s: GameState, player: PlayerIndex): LocationId {
  const def = tileDef('iron', 1)!;
  for (const [loc, locDef] of Object.entries(LOCATIONS)) {
    const slots = s.board.slots[loc as LocationId]!;
    const idx = locDef.slots.findIndex((sd, i) => sd.industries.includes('iron') && slots[i] === null);
    if (idx >= 0) {
      slots[idx] = { tile: def, player, flipped: false, resources: def.resourcesPlaced };
      return loc as LocationId;
    }
  }
  throw new Error('no iron slot found');
}

describe('audit-E 合规证据', () => {
  it('develop 弃 Wild 卡：Wild 回供应堆而非弃牌堆（规则书 p.11 Develop step 1 Exception / §9.14）', () => {
    const s = newGame(4, 3);
    const p = currentPlayer(s);
    const wild: Card = { id: 'wild-location-0', kind: 'wild-location' };
    s.players[p]!.hand = [wild, ...s.players[p]!.hand.slice(0, 7)];
    s.wildSupply = { location: 3, industry: 4 }; // 该 Wild 视为来自供应堆
    const act = enumerateActions(s, p).find(
      (a) => a.type === 'develop' && a.cardId === 'wild-location-0',
    )!;
    expect(act).toBeDefined();
    const after = applyAction(s, act);
    expect(after.wildSupply.location).toBe(4);
    expect(after.discard).toHaveLength(s.discard.length); // 弃牌堆不增加
    expect(after.discard.some((c) => c.id === 'wild-location-0')).toBe(false);
  });

  it('loan 弃 Wild 卡：Wild 回供应堆（规则书 p.11 Loan step 1 Exception）', () => {
    const s = newGame(4, 3);
    const p = currentPlayer(s);
    const wild: Card = { id: 'wild-industry-0', kind: 'wild-industry' };
    s.players[p]!.hand = [wild, ...s.players[p]!.hand.slice(0, 7)];
    s.wildSupply = { location: 4, industry: 3 };
    const act = enumerateActions(s, p).find(
      (a) => a.type === 'loan' && a.cardId === 'wild-industry-0',
    )!;
    expect(act).toBeDefined();
    const after = applyAction(s, act);
    expect(after.wildSupply.industry).toBe(4);
    expect(after.discard).toHaveLength(s.discard.length);
  });

  it('pass 弃 Wild 卡：Wild 回供应堆（规则书 p.6 Passing + §9.14）', () => {
    const s = newGame(4, 3);
    const p = currentPlayer(s);
    const wild: Card = { id: 'wild-location-1', kind: 'wild-location' };
    s.players[p]!.hand = [wild, ...s.players[p]!.hand.slice(0, 7)];
    s.wildSupply = { location: 3, industry: 4 };
    const act = enumerateActions(s, p).find(
      (a) => a.type === 'pass' && a.cardId === 'wild-location-1',
    )!;
    expect(act).toBeDefined();
    const after = applyAction(s, act);
    expect(after.wildSupply.location).toBe(4);
    expect(after.discard).toHaveLength(s.discard.length);
  });

  it('develop 铁耗尽规划按块分档：只够 1 块铁钱时枚举单块、不枚举双块（空市场 £6/块，规则书 p.8）', () => {
    const s = newGame(4, 3);
    s.ironMarket = 0; // 市场空，无铁厂 → 每块 £6
    s.players[0]!.money = 6;
    const devs = enumerateDevelop(s, 0);
    expect(devs.some((a) => a.type === 'develop' && a.removals.length === 1)).toBe(true);
    expect(devs.some((a) => a.type === 'develop' && a.removals.length === 2)).toBe(false);
  });

  it('develop 铁厂+市场混源：铁厂 1 块免费（耗尽立即翻面+进收入），第 2 块市场买（规则书 p.8 + 社区共识）', () => {
    const s = newGame(4, 3);
    const loc = withIronWorks(s, 1); // 对手铁厂，4 块铁
    s.board.slots[loc]!.find((t) => t !== null)!.resources = 1; // 只剩 1 块
    const devs = enumerateDevelop(s, 0);
    const two = devs.find((a) => a.type === 'develop' && a.removals.length === 2)!;
    expect(two).toBeDefined(); // 1 免费 + 1 市场 £2 可负担 → 应枚举
    const after = applyDevelop(s, 0, two);
    const works = after.board.slots[loc]!.find((t) => t !== null)!;
    expect(works.resources).toBe(0);
    expect(works.flipped).toBe(true); // 耗尽立即翻面
    expect(after.players[1]!.incomeSpace).toBe(10 + 3); // 对手进收入（iron I 前进 3 格）
    expect(after.players[0]!.money).toBe(17 - 2); // 第 2 块走市场 £2
    expect(after.ironMarket).toBe(7);
  });
});

describe('audit-E 疑点确证', () => {
  it('scout 生成的 Wild 卡 id 在“归还后再拿”路径下与在流通 Wild 冲突（卡牌 id 唯一性破坏）', () => {
    // 可达路径（4p）：4 人各 Scout 一次（wl-0..3 全部在流通，供应 0）；
    // 某人通过 Pass 等行动弃掉 wl-0（回供应，供应=1）；无 Wild 者再 Scout。
    // applyScout 的 id 公式 `wild-location-${COUNT - supply}` = wild-location-3，
    // 与仍在另一玩家手中的 wl-3 撞号。此处直接构造等价局面。
    const s = newGame(4, 3);
    s.players[1]!.hand = [
      { id: 'wild-location-3', kind: 'wild-location' },
      { id: 'wild-industry-3', kind: 'wild-industry' },
      ...s.players[1]!.hand.slice(0, 6),
    ];
    s.wildSupply = { location: 1, industry: 1 };
    const cardIds = s.players[0]!.hand.slice(0, 3).map((c) => c.id) as [string, string, string];
    const after = applyScout(s, 0, { type: 'scout', cardIds });

    const allIds = after.players.flatMap((ps) => ps.hand.map((c) => c.id));
    const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
    expect(dupes).toEqual([]); // 期望无重复 id；实际会拿到重复的 wild-location-3 / wild-industry-3
  });
});
