import { describe, expect, it } from 'vitest';
import {
  checkEraEnd,
  finalScore,
  scoreEraLinks,
  scoreFlippedIndustries,
} from '../src/era.js';
import { actionsPerRound, endTurnIfNeeded } from '../src/turn.js';
import { newGame, type GameState, type PlacedTile } from '../src/state.js';
import { LOCATIONS } from '../src/data/board.js';
import { tileDef } from '../src/data/tiles.js';
import { buildDeck } from '../src/data/cards.js';
import { INCOME_LEVEL_SPACES } from '../src/data/income.js';
import type { IndustryType, LocationId, PlayerIndex } from '../src/types.js';

// LINKS 下标锚点（board.ts §1.2 表内 # - 1）：
// birmingham–walsall = 8；kidderminster–worcester（三端点，含 farm-south）= 29。
// 板块数值锚点：cotton L1 linkIcons=1；iron L1 linkIcons=1；brewery L1/L2 linkIcons=2；
// coal L1 vp=1、coal L2 vp=2。

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
  opts: { level?: number; flipped?: boolean; slot?: number } = {},
): PlacedTile {
  const def = tileDef(industry, opts.level ?? 1);
  if (!def) throw new Error('missing tile def');
  const slot = opts.slot ?? findSlot(loc, industry);
  const placed: PlacedTile = {
    tile: def,
    player,
    flipped: opts.flipped ?? false,
    resources: def.resourcesPlaced,
  };
  s.board.slots[loc]![slot] = placed;
  return placed;
}

/** 手工铺一条 Link（linkIndex 0 基）。 */
function withLink(s: GameState, linkIndex: number, player: PlayerIndex): void {
  s.board.links.push({ linkIndex, player, era: 'canal' });
}

/** 时代结束待清算状态：deck/手牌空、eraEndPending 置位、弃牌堆装满整副牌供重洗。 */
function eraEndingState(era: 'canal' | 'rail', mutate?: (s: GameState) => void): GameState {
  const s = newGame(4, 3);
  s.era = era;
  s.deck = [];
  for (const pl of s.players) pl.hand = [];
  s.discard = buildDeck(4); // 64 张，供运河末重洗重抽
  s.eraEndPending = true;
  mutate?.(s);
  return s;
}

describe('scoreEraLinks', () => {
  it('scores 1 VP per link-icon on FLIPPED tiles in both endpoint locations', () => {
    const s = newGame(4, 3);
    // birmingham：翻面 cotton L1（1 图标）+ 未翻面 iron L1（1 图标但不计）
    withTile(s, 1, 'birmingham', 'cotton', { flipped: true });
    withTile(s, 1, 'birmingham', 'iron', { flipped: false });
    // walsall：翻面 brewery L1（2 图标）
    withTile(s, 2, 'walsall', 'brewery', { flipped: true });
    withLink(s, 8, 0); // birmingham–walsall 归 player 0

    const after = scoreEraLinks(s);
    expect(after.players[0]!.vp).toBe(3); // 1 + 2，未翻面铁厂不计
    expect(after.players[1]!.vp).toBe(0); // 板块 owner 不得 Link 分
    expect(after.players[2]!.vp).toBe(0);
  });

  it('kidderminster–worcester link also counts flipped tiles at farm-south', () => {
    const s = newGame(4, 3);
    withTile(s, 3, 'farm-south', 'brewery', { level: 2, flipped: true }); // 2 图标
    withLink(s, 29, 1);

    const after = scoreEraLinks(s);
    expect(after.players[1]!.vp).toBe(2);
  });

  it('removes all links from the board after scoring', () => {
    const s = newGame(4, 3);
    withLink(s, 8, 0);
    withLink(s, 29, 1);
    const after = scoreEraLinks(s);
    expect(after.board.links).toEqual([]);
    expect(s.board.links).toHaveLength(2); // 纯函数不改入参
  });

  it('unlinked flipped tiles score nothing (link scoring is per-link)', () => {
    const s = newGame(4, 3);
    withTile(s, 0, 'birmingham', 'cotton', { flipped: true });
    const after = scoreEraLinks(s);
    expect(after.players[0]!.vp).toBe(0);
  });
});

describe('scoreFlippedIndustries', () => {
  it('awards printed VP of flipped tiles to their owners; unflipped score nothing', () => {
    const s = newGame(4, 3);
    withTile(s, 0, 'cannock', 'coal', { level: 1, flipped: true, slot: 0 }); // vp 1
    withTile(s, 0, 'cannock', 'coal', { level: 2, flipped: true, slot: 1 }); // vp 2
    withTile(s, 1, 'dudley', 'coal', { level: 1, flipped: false }); // 未翻面不计
    const after = scoreFlippedIndustries(s);
    expect(after.players[0]!.vp).toBe(3);
    expect(after.players[1]!.vp).toBe(0);
  });
});

describe('checkEraEnd: canal → rail', () => {
  it('is a no-op when eraEndPending is false', () => {
    const s = newGame(4, 3);
    expect(checkEraEnd(s)).toBe(s);
  });

  it('removes level-1 tiles (flipped or not); level-2+ kept and already scored', () => {
    const s = eraEndingState('canal', (st) => {
      withTile(st, 0, 'cannock', 'coal', { level: 1, flipped: true, slot: 0 }); // vp 1，移除
      withTile(st, 0, 'cannock', 'coal', { level: 2, flipped: true, slot: 1 }); // vp 2，保留
      withTile(st, 1, 'dudley', 'coal', { level: 1, flipped: false }); // 未翻面也移除、不计分
    });
    const after = checkEraEnd(s);
    expect(after.players[0]!.vp).toBe(3); // 两块翻面均入账
    expect(after.players[1]!.vp).toBe(0);
    expect(after.board.slots['cannock']![0]).toBeNull(); // level 1 退出游戏
    expect(after.board.slots['cannock']![1]).not.toBeNull(); // level 2 保留（铁路时代可再计分）
    expect(after.board.slots['dudley']![0]).toBeNull();
  });

  it('merchant beer refills to one barrel per non-blank tile; blanks produce nothing', () => {
    const s = eraEndingState('canal', (st) => {
      st.merchants['oxford'] = { tiles: ['cotton', 'manufacturer'], beer: 0 };
      st.merchants['shrewsbury'] = { tiles: ['any'], beer: 0 };
      st.merchants['gloucester'] = { tiles: ['blank', 'blank'], beer: 0 };
    });
    const after = checkEraEnd(s);
    expect(after.merchants['oxford']!.beer).toBe(2);
    expect(after.merchants['shrewsbury']!.beer).toBe(1);
    expect(after.merchants['gloucester']!.beer).toBe(0);
  });

  it('reshuffles discards into a new deck, redeals 8 each, era becomes rail', () => {
    const s = eraEndingState('canal');
    const after = checkEraEnd(s);
    expect(after.era).toBe('rail');
    expect(after.eraEndPending).toBe(false);
    expect(after.players.every((p) => p.hand.length === 8)).toBe(true);
    expect(after.deck).toHaveLength(64 - 32);
    expect(after.discard).toEqual([]);
    expect(after.rngState).not.toBe(s.rngState); // 重洗消耗了 rng
  });

  it('reshuffle is deterministic from the stored rngState', () => {
    const s = eraEndingState('canal');
    const a = checkEraEnd(s);
    const b = checkEraEnd(s);
    expect(a.deck.map((c) => c.id)).toEqual(b.deck.map((c) => c.id));
    expect(a.players[0]!.hand.map((c) => c.id)).toEqual(b.players[0]!.hand.map((c) => c.id));
    expect(a.rngState).toBe(b.rngState);
  });

  it('rail era round 1 is a normal 2-action round', () => {
    const after = checkEraEnd(eraEndingState('canal'));
    // era='rail' 后即使 round===1 也是 2 行动（"1 行动"仅限运河时代第 1 轮）
    expect(actionsPerRound(after)).toBe(2);
  });
});

describe('finalScore (rail era end → game over)', () => {
  it('§9.5: level-2+ tile kept from canal era scores AGAIN at rail end (二次计分)', () => {
    const s = eraEndingState('rail', (st) => {
      withTile(st, 0, 'cannock', 'coal', { level: 2, flipped: true, slot: 1 }); // vp 2
      st.players[0]!.vp = 2; // 模拟运河末已入账一次
    });
    const after = finalScore(s);
    expect(after.players[0]!.vp).toBe(4); // 铁路末再计一次
    expect(after.board.slots['cannock']![1]).not.toBeNull(); // 终局不移除板块
  });

  it('winner by VP; phase game-over; eraEndPending cleared', () => {
    const s = eraEndingState('rail', (st) => {
      st.players[0]!.vp = 10;
      st.players[1]!.vp = 20;
      st.players[2]!.vp = 5;
      st.players[3]!.vp = 7;
    });
    const after = checkEraEnd(s);
    expect(after.phase).toBe('game-over');
    expect(after.winner).toEqual([1]);
    expect(after.eraEndPending).toBe(false);
  });

  it('VP tie broken by income level', () => {
    const s = eraEndingState('rail', (st) => {
      st.players[0]!.vp = 10;
      st.players[1]!.vp = 10;
      st.players[0]!.incomeSpace = INCOME_LEVEL_SPACES(5)[0]; // 等级 5
      st.players[1]!.incomeSpace = INCOME_LEVEL_SPACES(3)[0]; // 等级 3
    });
    expect(finalScore(s).winner).toEqual([0]);
  });

  it('VP and income tie broken by cash', () => {
    const s = eraEndingState('rail', (st) => {
      st.players[0]!.vp = 10;
      st.players[1]!.vp = 10;
      st.players[0]!.money = 30;
      st.players[1]!.money = 10;
    });
    expect(finalScore(s).winner).toEqual([0]);
  });

  it('full tie → shared winners', () => {
    const s = eraEndingState('rail', (st) => {
      st.players[0]!.vp = 10;
      st.players[1]!.vp = 10;
    });
    expect(finalScore(s).winner).toEqual([0, 1]);
  });

  it('money is NOT converted to VP', () => {
    const s = eraEndingState('rail', (st) => {
      st.players[0]!.vp = 10;
      st.players[0]!.money = 100;
      st.players[1]!.vp = 11;
      st.players[1]!.money = 0;
    });
    expect(finalScore(s).winner).toEqual([1]);
  });

  it('rail-end scoring runs before winner determination (flipped tiles + links)', () => {
    const s = eraEndingState('rail', (st) => {
      st.players[1]!.vp = 3;
      withTile(st, 0, 'cannock', 'coal', { level: 2, flipped: true, slot: 0 }); // 1 图标 + vp 2
      withTile(st, 0, 'walsall', 'brewery', { level: 1, flipped: true }); // 2 图标 + vp 4
      withLink(st, 17, 0); // cannock–walsall：1 + 2 = 3 Link VP
    });
    const after = finalScore(s);
    // player 0：2(板块) + 4(板块) + 3(Link) = 9 > player 1 的 3
    expect(after.players[0]!.vp).toBe(9);
    expect(after.winner).toEqual([0]);
    expect(after.board.links).toEqual([]);
  });
});

describe('endTurnIfNeeded integration', () => {
  it('consumes eraEndPending at round end: canal state becomes rail in one call', () => {
    const s = newGame(4, 3);
    s.round = 2;
    s.actionsThisTurn = 2;
    s.currentPlayerIdx = 3;
    s.deck = [];
    for (const pl of s.players) pl.hand = [];
    s.discard = buildDeck(4);
    const after = endTurnIfNeeded(s);
    expect(after.era).toBe('rail');
    expect(after.eraEndPending).toBe(false);
    expect(after.players.every((p) => p.hand.length === 8)).toBe(true);
  });

  it('rail era end at round end goes straight to game-over with a winner', () => {
    const s = newGame(4, 3);
    s.era = 'rail';
    s.round = 9;
    s.actionsThisTurn = 2;
    s.currentPlayerIdx = 3;
    s.deck = [];
    for (const pl of s.players) pl.hand = [];
    s.players[2]!.vp = 42;
    const after = endTurnIfNeeded(s);
    expect(after.phase).toBe('game-over');
    expect(after.winner).toEqual([2]);
  });
});
