/**
 * 审计域 H：时代切换与计分。
 *
 * 规则出处：
 * - 规则书 p.6（txt 行 584-590）："until both the Draw Deck and players' Hands are
 *   exhausted. There are exactly 8/9/10 rounds per era in a 4/3/2-players game."
 * - 规则书 p.6（txt 行 644-649）：回合末收收入，"Exception: Income is not collected
 *   at the end of the final round of the game."（即运河时代末轮照常收）
 * - 规则书 p.7（txt 行 738-771）：时代末 Link 计分（只数已翻面板块连接图标）→
 *   翻面产业计分；运河末额外 4 步；终局平局 VP→收入→现金→共同获胜。
 * - 规则书 p.8（txt 行 786-791、922-931）：煤/铁/酿在最后 1 个资源被移走时立即翻面
 *   （常发生在对手回合）；翻面立即按右下**格数**前进收入，上限收入等级 30。
 * - rules-reference §7、§9.5/§9.6/§9.18。
 */
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/apply.js';
import { checkEraEnd, finalScore, scoreEraLinks } from '../src/era.js';
import { applyFlip, consumeBeer, consumeCoal } from '../src/resources.js';
import { newGame, type GameState, type PlacedTile } from '../src/state.js';
import { endTurnIfNeeded } from '../src/turn.js';
import { LOCATIONS } from '../src/data/board.js';
import { buildDeck } from '../src/data/cards.js';
import { incomeLevelAt } from '../src/data/income.js';
import { tileDef } from '../src/data/tiles.js';
import type { IndustryType, LocationId, PlayerIndex } from '../src/types.js';

function findSlot(loc: LocationId, industry: IndustryType): number {
  const slots = LOCATIONS[loc]!.slots;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]!.industries.includes(industry)) return i;
  }
  throw new Error(`no slot for ${industry} at ${loc}`);
}

/** 手工放置板块（绕过建造校验）。 */
function withTile(
  s: GameState,
  player: PlayerIndex,
  loc: LocationId,
  industry: IndustryType,
  opts: { level?: number; flipped?: boolean; resources?: number } = {},
): PlacedTile {
  const def = tileDef(industry, opts.level ?? 1);
  if (!def) throw new Error('missing tile def');
  const placed: PlacedTile = {
    tile: def,
    player,
    flipped: opts.flipped ?? false,
    resources: opts.resources ?? def.resourcesPlaced,
  };
  s.board.slots[loc]![findSlot(loc, industry)] = placed;
  return placed;
}

/** 全程只 Pass 地打完整局，返回每时代轮数与每人行动数。 */
function playPassOnlyGame(playerCount: 2 | 3 | 4, seed: number) {
  let s = newGame(playerCount, seed);
  const canalActions = new Array<number>(playerCount).fill(0);
  const railActions = new Array<number>(playerCount).fill(0);
  let canalRounds = 0;
  let railRounds = 0;
  let guard = 0;
  while (s.phase !== 'game-over') {
    if (++guard > 3000) throw new Error('game did not end (deadlock?)');
    const eraBefore = s.era;
    const p = s.turnOrder[s.currentPlayerIdx]!;
    const card = s.players[p]!.hand[0];
    if (!card) throw new Error(`player ${p} has no card but was not skipped`);
    s = applyAction(s, { type: 'pass', cardId: card.id });
    (eraBefore === 'canal' ? canalActions : railActions)[p]!++;
    if (eraBefore === 'canal' && s.era === 'rail') canalRounds = s.round - 1;
    if (s.phase === 'game-over') railRounds = s.round - 1 - canalRounds;
  }
  return { canalRounds, railRounds, canalActions, railActions };
}

describe('audit-H 确证: 时代长度（规则书 p.6 "exactly 8/9/10 rounds per era"）', () => {
  // 规则书 p.6（txt 行 584-590）：牌堆与手牌同时耗尽时时代结束，
  // "There are exactly 8/9/10 rounds per era in a 4/3/2-players game."
  // 卡牌守恒：只有每位玩家各 1 张弃牌堆底（规则书 p.5 步骤 9，逐玩家设置），
  // 运河时代才恰好 2R−1 次行动/人（N − playerCount = playerCount×(2R−1)）。
  // 引擎 state.ts 全局只放 1 张堆底 → 运河时代多 1 轮且行动数不均。
  it.each([
    [4, 8, 15],
    [3, 9, 17],
    [2, 10, 19],
  ] as const)('%ip 运河时代恰好 %i 轮、每人恰 %i 次行动', (n, rounds, actionsEach) => {
    const { canalRounds, canalActions } = playPassOnlyGame(n, 3);
    expect(canalRounds).toBe(rounds);
    expect(canalActions).toEqual(new Array<number>(n).fill(actionsEach));
  });

  it('铁路时代长度正确（弃牌堆底已重洗入牌堆后卡牌守恒恢复）', () => {
    // 合规证据：运河末重洗把全部 N 张洗回 → 铁路时代恰好 2R 次行动/人。
    for (const [n, rounds, actionsEach] of [
      [4, 8, 16],
      [3, 9, 18],
      [2, 10, 20],
    ] as const) {
      const { railRounds, railActions } = playPassOnlyGame(n, 3);
      expect(railRounds).toBe(rounds);
      expect(railActions).toEqual(new Array<number>(n).fill(actionsEach));
    }
  });
});

describe('audit-H 合规: 翻面与收入（规则书 p.8）', () => {
  it('翻面收入按格前进，触顶收入等级 30（格 99）不再上涨', () => {
    const s = newGame(4, 3);
    withTile(s, 0, 'burton-on-trent', 'brewery'); // incomeAdvance 4
    const slot = findSlot('burton-on-trent', 'brewery');
    s.players[0]!.incomeSpace = 98; // 等级 30 区间内
    const r = applyFlip(s, 'burton-on-trent', slot);
    expect(r.state.players[0]!.incomeSpace).toBe(99);
    expect(incomeLevelAt(r.state.players[0]!.incomeSpace)).toBe(30);
    expect(r.event.incomeAdvance).toBe(4);
  });

  it('对手酒厂最后 1 桶被喝走时立即翻面，收入归对手（常发生在对手回合）', () => {
    const s = newGame(4, 3);
    withTile(s, 1, 'burton-on-trent', 'brewery', { resources: 1 });
    const slot = findSlot('burton-on-trent', 'brewery');
    // player 0 在 burton-on-trent 用酒（连通含自身），player 1 的酒厂只剩 1 桶
    const r = consumeBeer(s, 0, 1, { at: 'burton-on-trent', useMerchantBeer: false });
    expect(r.state.board.slots['burton-on-trent']![slot]!.flipped).toBe(true);
    expect(r.state.players[1]!.incomeSpace).toBe(10 + 4); // 对手立即进收入
    expect(r.state.players[0]!.incomeSpace).toBe(10);
    expect(r.flipped).toHaveLength(1);
    expect(r.flipped[0]!.player).toBe(1);
  });

  it('对手煤矿最后 1 块被取走时立即翻面，收入归对手', () => {
    const s = newGame(4, 3);
    withTile(s, 1, 'dudley', 'coal', { resources: 1 });
    const slot = findSlot('dudley', 'coal');
    const r = consumeCoal(s, 0, 'dudley', 1);
    expect(r.state.board.slots['dudley']![slot]!.flipped).toBe(true);
    expect(r.state.players[1]!.incomeSpace).toBe(10 + 4); // coal L1 incomeAdvance 4
    expect(r.flipped[0]!.player).toBe(1);
  });
});

describe('audit-H 合规: 时代结束触发与轮末收入（规则书 p.6/p.7）', () => {
  it('牌堆空但仍有玩家持牌时，轮末不触发时代切换', () => {
    const s = newGame(4, 3);
    s.round = 2;
    s.actionsThisTurn = 2;
    s.currentPlayerIdx = 3;
    s.deck = [];
    for (let i = 1; i < 4; i++) s.players[i]!.hand = [];
    // player 0 仍有手牌 → 时代未结束
    const after = endTurnIfNeeded(s);
    expect(after.era).toBe('canal');
    expect(after.eraEndPending).toBe(false);
    expect(after.round).toBe(3);
  });

  it('运河时代末轮照常收收入（"final round of the game" 例外仅指全局末轮）', () => {
    const s = newGame(4, 3);
    s.round = 2;
    s.actionsThisTurn = 2;
    s.currentPlayerIdx = 3;
    s.deck = [];
    for (const pl of s.players) pl.hand = [];
    s.discard = buildDeck(4);
    s.players[0]!.incomeSpace = 12; // 等级 +1
    s.players[0]!.money = 17;
    const after = endTurnIfNeeded(s);
    expect(after.era).toBe('rail');
    expect(after.players[0]!.money).toBe(18); // 运河末轮收入 +1 已入账
  });

  it('铁路时代末轮（全局末轮）不收收入', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    s.round = 9;
    s.actionsThisTurn = 2;
    s.currentPlayerIdx = 3;
    s.deck = [];
    for (const pl of s.players) pl.hand = [];
    s.players[0]!.incomeSpace = 12; // 等级 +1
    s.players[0]!.money = 17;
    const after = endTurnIfNeeded(s);
    expect(after.phase).toBe('game-over');
    expect(after.players[0]!.money).toBe(17); // 未收收入
  });
});

describe('audit-H 合规: Link 计分与终局（规则书 p.7）', () => {
  it('商人位端点固定提供 2 个连接图标：birmingham–oxford = birmingham 侧 1 + 商人位 2', () => {
    // 2026-08-26 规则修正：商人位板面印 2 个连接图标（实物版图目视 + 官方规则书
    // "score 1 VP for each link icon displayed in adjacent locations"），旧断言（商人位 0）有误。
    const s = newGame(4, 3);
    withTile(s, 1, 'birmingham', 'cotton', { flipped: true }); // 1 连接图标
    s.board.links.push({ linkIndex: 5, player: 0, era: 'canal' }); // birmingham–oxford
    const after = scoreEraLinks(s);
    expect(after.players[0]!.vp).toBe(3); // birmingham 侧 1 + oxford 商人位 2
    expect(after.board.links).toEqual([]);
  });

  it('平局按收入"等级"而非格数：同等级不同格 → 继续比现金', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    s.deck = [];
    for (const pl of s.players) pl.hand = [];
    s.discard = buildDeck(4);
    s.eraEndPending = true;
    s.players[0]!.vp = 10;
    s.players[1]!.vp = 10;
    s.players[0]!.incomeSpace = 11; // 等级 1（首格）
    s.players[1]!.incomeSpace = 12; // 等级 1（次格）——等级相同
    s.players[0]!.money = 20;
    s.players[1]!.money = 10;
    expect(finalScore(s).winner).toEqual([0]); // 收入等级平 → 现金决胜
  });

  it('2p 运河末：40 张弃牌合洗，重抽 8 张/人后牌堆余 24', () => {
    const s = newGame(2, 3);
    s.deck = [];
    for (const pl of s.players) pl.hand = [];
    s.discard = buildDeck(2); // 40 张
    s.eraEndPending = true;
    const after = checkEraEnd(s);
    expect(after.era).toBe('rail');
    expect(after.players.every((p) => p.hand.length === 8)).toBe(true);
    expect(after.deck).toHaveLength(40 - 16);
    expect(after.discard).toEqual([]);
  });
});
