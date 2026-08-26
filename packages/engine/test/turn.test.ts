import { describe, expect, it } from 'vitest';
import { newGame, type GameState } from '../src/state.js';
import { applyAction, enumerateActions } from '../src/apply.js';
import { eraEndCondition, endTurnIfNeeded } from '../src/turn.js';
import { IllegalActionError } from '../src/errors.js';
import { LOCATIONS } from '../src/data/board.js';
import { buildDeck } from '../src/data/cards.js';
import { INCOME_LEVEL_SPACES } from '../src/data/income.js';
import { BREWERY_BARRELS } from '../src/data/market.js';
import { tileDef } from '../src/data/tiles.js';
import type { Action, IndustryType, LocationId, PlayerIndex } from '../src/types.js';

// 辅助：给玩家一块板（直接改 state.board.slots，放到该产业首个匹配空槽）。
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

/** 构造"一轮的最后一步已完成"的待结算状态（round 2，最后一名玩家已行动满）。 */
function roundEndState(mutate?: (s: GameState) => void): GameState {
  const s = newGame(4, 3);
  s.round = 2;
  s.actionsThisTurn = 2; // 普通轮每人 2 行动
  s.currentPlayerIdx = 3; // 最后一名玩家
  mutate?.(s);
  return s;
}

describe('enumerateActions', () => {
  it('returns [] when phase is game-over', () => {
    const s = newGame(4, 3);
    s.phase = 'game-over';
    expect(enumerateActions(s, s.turnOrder[0]!)).toEqual([]);
  });

  it('aggregates all action types plus one pass per hand card', () => {
    const s = newGame(4, 3);
    const p = s.turnOrder[0]!;
    s.players[p]!.hand = [
      { id: 'c1', kind: 'location', location: 'worcester' },
      { id: 'c2', kind: 'industry', industries: ['coal'] },
      { id: 'c3', kind: 'industry', industries: ['iron'] },
    ];
    const types = new Set(enumerateActions(s, p).map((a) => a.type));
    // 场上无可卖板块 → sell 缺席；其余五类 + pass 全部在册
    expect(types).toEqual(new Set(['build', 'network', 'develop', 'loan', 'scout', 'pass']));
    const passes = enumerateActions(s, p).filter((a) => a.type === 'pass');
    expect(passes.map((a) => (a.type === 'pass' ? a.cardId : ''))).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('applyAction validation', () => {
  it('rejects actions outside enumerateActions with code illegal-action', () => {
    const s = newGame(4, 3);
    let err: unknown;
    try {
      applyAction(s, { type: 'pass', cardId: 'nope' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IllegalActionError);
    expect((err as IllegalActionError).code).toBe('illegal-action');
  });

  it('rejects a pass naming a card held by another player', () => {
    const s = newGame(4, 3);
    const other = s.turnOrder[1]!;
    const foreignCard = s.players[other]!.hand[0]!.id;
    expect(() => applyAction(s, { type: 'pass', cardId: foreignCard })).toThrowError(
      IllegalActionError,
    );
  });
});

describe('applyAction post-processing', () => {
  it('pass discards the card, refills hand to 8, and clears lastEvents (task 9 leftover)', () => {
    const s = newGame(4, 3);
    const p = s.turnOrder[0]!;
    const cardId = s.players[p]!.hand[0]!.id;
    s.lastEvents = [{ kind: 'flip', player: p, location: 'derby', incomeAdvance: 1 }];
    const deckBefore = s.deck.length;
    const discardBefore = s.discard.length;

    const after = applyAction(s, { type: 'pass', cardId });
    expect(after.players[p]!.hand).toHaveLength(8);
    expect(after.players[p]!.hand.some((c) => c.id === cardId)).toBe(false);
    expect(after.deck).toHaveLength(deckBefore - 1);
    expect(after.discard).toHaveLength(discardBefore + 1);
    expect(after.discard[after.discard.length - 1]!.id).toBe(cardId);
    expect(after.lastEvents).toEqual([]);
  });

  it('wild card discarded by unified discard returns to wild supply, not the discard pile', () => {
    const s = newGame(4, 3);
    const p = s.turnOrder[0]!;
    s.players[p]!.hand[0] = { id: 'wl-0', kind: 'wild-location' };
    s.wildSupply = { ...s.wildSupply, location: 3 };
    const discardBefore = s.discard.length;

    const after = applyAction(s, { type: 'pass', cardId: 'wl-0' });
    expect(after.wildSupply.location).toBe(4);
    expect(after.discard).toHaveLength(discardBefore);
  });

  it('loan: applyAction handles the discard on top of the module effect', () => {
    const s = newGame(4, 3);
    const p = s.turnOrder[0]!;
    const cardId = s.players[p]!.hand[0]!.id;
    const after = applyAction(s, { type: 'loan', cardId });
    expect(after.players[p]!.money).toBe(17 + 30);
    expect(after.players[p]!.incomeSpace).toBe(INCOME_LEVEL_SPACES(-3)[1]);
    expect(after.discard[after.discard.length - 1]!.id).toBe(cardId);
    expect(after.players[p]!.hand).toHaveLength(8);
  });

  it('build discards exactly once (module already discarded; applyAction must not repeat)', () => {
    const s = newGame(4, 3);
    const p = s.turnOrder[0]!;
    const discardBefore = s.discard.length;
    const build = enumerateActions(s, p).find((a) => a.type === 'build')!;
    const after = applyAction(s, build);
    expect(after.discard).toHaveLength(discardBefore + 1);
    expect(after.players[p]!.hand).toHaveLength(8);
  });

  it('scout discards exactly its 3 cards (applyAction must not discard again)', () => {
    const s = newGame(4, 3);
    const p = s.turnOrder[0]!;
    const discardBefore = s.discard.length;
    const scout = enumerateActions(s, p).find((a) => a.type === 'scout')!;
    const after = applyAction(s, scout);
    expect(after.discard).toHaveLength(discardBefore + 3);
    // 8 - 3 弃 + 2 wild + 1 补 = 8
    expect(after.players[p]!.hand).toHaveLength(8);
    expect(after.wildSupply).toEqual({ location: 3, industry: 3 });
  });

  it('writes module events ({state, events} shape) into state.lastEvents', () => {
    const s = newGame(4, 3);
    const p = s.turnOrder[0]!;
    withTile(s, (p + 1) % 4, 'dudley', 'coal', 1); // 对手煤矿同地供 1 煤（不触发 canal 每地限 1 块）
    s.ironMarket = 0; // 市场全空 → 铁厂 4 块铁全卖出 → 建成即翻面
    s.players[p]!.hand = [{ id: 'c1', kind: 'industry', industries: ['iron'] }];

    const after = applyAction(s, {
      type: 'build',
      cardId: 'c1',
      industry: 'iron',
      location: 'dudley',
    });
    // 首建特例任意地点；铁 I：£5 + 1 煤（对手矿免费）；卖 4 块铁得 £5+£5+£4+£4 = £18，卖空翻面
    expect(after.players[p]!.money).toBe(17 - 5 + 18);
    expect(after.players[p]!.spentThisRound).toBe(5);
    expect(after.lastEvents).toEqual([
      { kind: 'flip', player: p, location: 'dudley', incomeAdvance: 3 },
    ]);
  });

  it('network with explicit beerFromOpponentBrewery passes the legality gate and drinks the pinned brewery', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    const p = s.turnOrder[0]!;
    withTile(s, p, 'coventry', 'coal'); // 煤矿（2 块）供两条铁路的煤
    withTile(s, (p + 1) % 4, 'nuneaton', 'brewery', 1); // 对手酒厂（铁路时代 2 桶）
    s.players[p]!.money = 30;

    const dbl = enumerateActions(s, p).find(
      (a): a is Extract<Action, { type: 'network' }> =>
        a.type === 'network' && a.links.length === 2 && a.links.includes(22),
    )!;
    expect(dbl).toBeDefined();
    const after = applyAction(s, { ...dbl, beerFromOpponentBrewery: 'nuneaton' });
    expect(after.board.links).toHaveLength(2);
    // 啤酒来自指定的对手酒厂（2 桶喝 1，不翻面），而非默认来源
    const brewery = after.board.slots['nuneaton']!.find(
      (t) => t !== null && t.tile.industry === 'brewery',
    )!;
    expect(brewery.resources).toBe(1);
    expect(brewery.flipped).toBe(false);
  });

  it('money spent on market purchases counts toward spentThisRound', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    const p = s.turnOrder[0]!;
    withTile(s, p, 'derby', 'brewery', 2); // derby-nottingham 边连通商人位供买煤
    s.players[p]!.money = 30;
    s.players[p]!.hand = [{ id: 'c1', kind: 'industry', industries: ['coal'] }];

    const single = enumerateActions(s, p).find(
      (a) => a.type === 'network' && a.links.length === 1,
    )!;
    const after = applyAction(s, single);
    // 单条铁路 £5 + 1 煤（市场 £1）
    expect(after.players[p]!.money).toBe(30 - 6);
    expect(after.players[p]!.spentThisRound).toBe(6);
  });
});

describe('turn structure', () => {
  it('first canal round allows only 1 action per player', () => {
    const s = newGame(4, 3); // era canal, round 1
    expect(s.era).toBe('canal');
    expect(s.round).toBe(1);
    const p = s.turnOrder[0]!;
    const after = applyAction(s, { type: 'pass', cardId: s.players[p]!.hand[0]!.id });
    expect(after.currentPlayerIdx).toBe(1);
    expect(after.actionsThisTurn).toBe(0);
  });

  it('normal round allows 2 actions before advancing', () => {
    const s = newGame(4, 3);
    s.round = 2;
    const p = s.turnOrder[0]!;
    const mid = applyAction(s, { type: 'pass', cardId: s.players[p]!.hand[0]!.id });
    expect(mid.currentPlayerIdx).toBe(0);
    expect(mid.actionsThisTurn).toBe(1);
    const after = applyAction(mid, {
      type: 'pass',
      cardId: mid.players[p]!.hand[0]!.id,
    });
    expect(after.currentPlayerIdx).toBe(1);
    expect(after.actionsThisTurn).toBe(0);
  });

  it('rail era round 1 allows 2 actions (1-action exception is canal round 1 only)', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    const p = s.turnOrder[0]!;
    const after = applyAction(s, { type: 'pass', cardId: s.players[p]!.hand[0]!.id });
    expect(after.currentPlayerIdx).toBe(0);
    expect(after.actionsThisTurn).toBe(1);
  });

  it('turn order next round: least spent first, ties keep relative order', () => {
    const s = roundEndState((st) => {
      st.turnOrder = [0, 1, 2, 3]; // 固定本轮顺位（newGame 已洗混）
      st.players[0]!.spentThisRound = 5;
      st.players[1]!.spentThisRound = 0;
      st.players[2]!.spentThisRound = 3;
      st.players[3]!.spentThisRound = 3;
    });
    const after = endTurnIfNeeded(s);
    expect(after.turnOrder).toEqual([1, 2, 3, 0]);
    expect(after.players.every((pl) => pl.spentThisRound === 0)).toBe(true);
    expect(after.currentPlayerIdx).toBe(0);
    expect(after.round).toBe(3);
  });
});

describe('round-end income', () => {
  it('positive income pays out from the bank', () => {
    const s = roundEndState((st) => {
      st.players[0]!.incomeSpace = INCOME_LEVEL_SPACES(5)[0]; // 等级 +5
      st.players[0]!.money = 10;
    });
    const after = endTurnIfNeeded(s);
    expect(after.players[0]!.money).toBe(15);
  });

  it('negative income forces payment to the bank', () => {
    const s = roundEndState((st) => {
      st.players[0]!.incomeSpace = INCOME_LEVEL_SPACES(-3)[0]; // 等级 −3
      st.players[0]!.money = 10;
    });
    const after = endTurnIfNeeded(s);
    expect(after.players[0]!.money).toBe(7);
  });

  it('insufficient cash liquidates own tiles at half cost (floor), stopping once covered', () => {
    const s = roundEndState((st) => {
      st.players[0]!.incomeSpace = INCOME_LEVEL_SPACES(-3)[0]; // 欠 £3
      st.players[0]!.money = 1;
      withTile(st, 0, 'worcester', 'cotton', 1); // slot 0，半价 floor(12/2)=6
      withTile(st, 0, 'worcester', 'cotton', 1); // slot 1
    });
    const after = endTurnIfNeeded(s);
    // 拆 1 块得 £6（1+6=7 ≥ 3 即停），付 £3 余 £4；第 2 块保留
    expect(after.players[0]!.money).toBe(4);
    expect(after.board.slots['worcester']![0]).toBeNull();
    expect(after.board.slots['worcester']![1]).not.toBeNull();
  });

  it('still insufficient after liquidating everything: 1 VP per £1 missing (floor 0)', () => {
    const s = roundEndState((st) => {
      st.players[0]!.incomeSpace = INCOME_LEVEL_SPACES(-5)[0]; // 欠 £5
      st.players[0]!.money = 1;
      withTile(st, 0, 'dudley', 'coal', 1); // 半价 floor(5/2)=2
    });
    const after = endTurnIfNeeded(s);
    // 1 + 2 = 3 < 5 → 缺 £2 扣 2 VP（下限 0，VP 轨无负格），现金清零
    expect(after.players[0]!.money).toBe(0);
    expect(after.players[0]!.vp).toBe(0);
    expect(after.board.slots['dudley']![0]).toBeNull();
  });
});

describe('cardless auto-skip (deck empty)', () => {
  it('skips a hand-empty next player without consuming their actions', () => {
    const s = newGame(4, 3);
    s.round = 2; // 每人 2 行动
    s.deck = [];
    s.turnOrder = [0, 1, 2, 3];
    s.players[1]!.hand = []; // 下一位玩家已无牌
    const p = s.turnOrder[0]!;
    const mid = applyAction(s, { type: 'pass', cardId: s.players[p]!.hand[0]!.id });
    expect(mid.currentPlayerIdx).toBe(0); // 2 行动未满，仍 player 0
    const after = endTurnIfNeeded({ ...mid, actionsThisTurn: 2 });
    expect(after.currentPlayerIdx).toBe(2); // player 1 被跳过
    expect(after.actionsThisTurn).toBe(0);
  });

  it('current player running out of cards mid-turn ends their turn early', () => {
    const s = newGame(4, 3);
    s.round = 2;
    s.deck = [];
    s.turnOrder = [0, 1, 2, 3];
    s.players[0]!.hand = [{ id: 'c1', kind: 'location', location: 'worcester' }];
    const after = applyAction(s, { type: 'pass', cardId: 'c1' });
    // 1 行动（上限 2）但手牌打空且 deck 空 → 视为行动完成，直接推进
    expect(after.currentPlayerIdx).toBe(1);
    expect(after.actionsThisTurn).toBe(0);
  });

  it('scout-induced hand misalignment does not deadlock: game reaches the era transition', () => {
    const s = newGame(2, 3);
    s.round = 9;
    s.deck = [];
    s.turnOrder = [0, 1];
    // player 0 剩 1 张，player 1 已空手（scout 净 -2 手牌造成的末轮错位）
    s.players[0]!.hand = [{ id: 'c1', kind: 'location', location: 'worcester' }];
    s.players[1]!.hand = [];
    s.discard = buildDeck(2); // 40 张供重洗
    const after = applyAction(s, { type: 'pass', cardId: 'c1' });
    // player 0 打空 → 跳过空手玩家 → 轮末时代清算 → rail、重抽 8 张
    expect(after.era).toBe('rail');
    expect(after.eraEndPending).toBe(false);
    expect(after.players.every((pl) => pl.hand.length === 8)).toBe(true);
    // 重洗时弃牌堆 = 40 + 刚打出的 c1 = 41，抽 16 后余 25
    expect(after.deck).toHaveLength(41 - 16);
  });
});

describe('era end', () => {
  it('eraEndCondition: true only when deck and all hands are empty', () => {
    const s = newGame(4, 3);
    expect(eraEndCondition(s)).toBe(false);
    s.deck = [];
    expect(eraEndCondition(s)).toBe(false); // 手牌非空
    for (const pl of s.players) pl.hand = [];
    expect(eraEndCondition(s)).toBe(true);
  });

  it('newGame starts with eraEndPending false', () => {
    expect(newGame(4, 3).eraEndPending).toBe(false);
  });

  it('canal era final round still pays income, then resolves the era transition', () => {
    const s = roundEndState((st) => {
      st.deck = [];
      for (const pl of st.players) pl.hand = [];
      st.discard = buildDeck(4); // 供运河末重洗重抽
      st.players[0]!.incomeSpace = INCOME_LEVEL_SPACES(5)[0]; // 等级 +5
      st.players[0]!.money = 10;
    });
    const after = endTurnIfNeeded(s);
    expect(after.players[0]!.money).toBe(15); // 运河时代末轮正常发收入
    expect(after.era).toBe('rail'); // 时代清算在轮末即时消费 eraEndPending
    expect(after.eraEndPending).toBe(false);
    expect(after.round).toBe(3);
    expect(after.players.every((pl) => pl.hand.length === 8)).toBe(true);
  });

  it('final round of the game (rail era end) skips income and ends the game', () => {
    const s = roundEndState((st) => {
      st.era = 'rail';
      st.deck = [];
      for (const pl of st.players) pl.hand = [];
      st.players[0]!.incomeSpace = INCOME_LEVEL_SPACES(5)[0];
      st.players[0]!.money = 10;
      st.players[1]!.vp = 30;
    });
    const after = endTurnIfNeeded(s);
    expect(after.players[0]!.money).toBe(10); // 全局最后一轮不收收入
    expect(after.phase).toBe('game-over');
    expect(after.winner).toEqual([1]);
    expect(after.eraEndPending).toBe(false);
  });
});
