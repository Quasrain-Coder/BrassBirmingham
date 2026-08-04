/**
 * GameSession：权威对局会话（engine 裁决 + 落库 + 视角快照）。
 * 核心验收：整局随机对局经 session 推进，actions 表逐步落库（seq 从 0 连续），
 * 终局 final_state 落库且与"newGame(同种子) + 逐条重放 actions 表"逐字节一致。
 */
import { describe, expect, it } from 'vitest';
import { applyAction, createRng, newGame, stableStringify } from '@brass/engine';
import type { Action, GameState, PlayerIndex } from '@brass/engine';
import { eq } from 'drizzle-orm';
import { listActions, openDb, type Db } from '../src/db/repo.js';
import { games } from '../src/db/schema.js';
import { GameSession, SessionError, generateGameId } from '../src/session.js';

function seatsFor(playerCount: number, tokenPrefix = 'tok') {
  return Array.from({ length: playerCount }, (_, i) => ({
    seat: i as PlayerIndex,
    nickname: `p${i}`,
    token: `${tokenPrefix}-${i}`, // seats.token 全局唯一：同库多局须加前缀
  }));
}

/** 用 rng 驱动整局随机对局直到终局；返回行动数。 */
function playRandomGame(sess: GameSession, rngSeed: number): number {
  const rng = createRng(rngSeed);
  let steps = 0;
  while (!sess.finished) {
    const snap = sess.snapshotFor(sess.currentSeat);
    expect(snap.legalActions.length).toBeGreaterThan(0);
    const a = snap.legalActions[rng.nextInt(snap.legalActions.length)]!;
    sess.submitAction(sess.currentSeat, a);
    steps += 1;
    if (steps > 10000) throw new Error('runaway game');
  }
  return steps;
}

function readGameRow(db: Db, gameId: string) {
  return db
    .select({ status: games.status, finalState: games.finalState })
    .from(games)
    .where(eq(games.id, gameId))
    .get();
}

/** 抓 SessionError 并断言 code；未抛或非 SessionError 则测试失败。 */
function expectSessionError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SessionError);
    expect((e as SessionError).code).toBe(code);
    return;
  }
  expect.unreachable(`应抛 SessionError(${code})`);
}

describe('GameSession', () => {
  it('整局随机对局：每步落库、seq 从 0 连续、final_state 与重放逐字节一致', () => {
    const db = openDb(':memory:');
    const sess = new GameSession(db, 'g1', 4, 42, seatsFor(4));
    const steps = playRandomGame(sess, 1);

    expect(sess.finished).toBe(true);
    expect(steps).toBeGreaterThan(100);

    const rows = listActions(db, 'g1');
    expect(rows.length).toBe(steps);
    expect(rows[0]!.seq).toBe(0);
    // seq 连续无洞
    rows.forEach((r, i) => expect(r.seq).toBe(i));

    // 重放：actions 表逐条 apply，player 列必须等于当时行动玩家
    let s: GameState = newGame(4, 42);
    for (const row of rows) {
      expect(row.player).toBe(s.turnOrder[s.currentPlayerIdx]!);
      s = applyAction(s, row.action);
    }

    // 终局落库：status finished + final_state 与重放终态逐字节一致
    const row = readGameRow(db, 'g1');
    expect(row!.status).toBe('finished');
    expect(row!.finalState).not.toBeNull();
    expect(stableStringify(JSON.parse(row!.finalState!))).toBe(stableStringify(s));
    // 与 session 内存终态也一致
    expect(stableStringify(JSON.parse(row!.finalState!))).toBe(stableStringify(sess.state));
  });

  it('非当前玩家提交：not-your-turn，不落库', () => {
    const db = openDb(':memory:');
    const sess = new GameSession(db, 'g2', 2, 7, seatsFor(2));
    const current = sess.currentSeat;
    const other = (current === 0 ? 1 : 0) as PlayerIndex;
    const a = sess.snapshotFor(current).legalActions[0]!;

    expectSessionError(() => sess.submitAction(other, a), 'not-your-turn');
    expect(listActions(db, 'g2')).toHaveLength(0);
    expect(sess.snapshotFor(current).seq).toBe(0);
  });

  it('非法行动：engine IllegalActionError 的 code 透传（illegal-action），不落库', () => {
    const db = openDb(':memory:');
    const sess = new GameSession(db, 'g3', 2, 7, seatsFor(2));
    const bogus: Action = { type: 'pass', cardId: 'no-such-card' };

    expectSessionError(() => sess.submitAction(sess.currentSeat, bogus), 'illegal-action');
    expect(listActions(db, 'g3')).toHaveLength(0);
  });

  it('终局后提交：game-finished', () => {
    const db = openDb(':memory:');
    const sess = new GameSession(db, 'g4', 2, 7, seatsFor(2));
    playRandomGame(sess, 3);

    const any: Action = { type: 'pass', cardId: 'whatever' };
    expectSessionError(() => sess.submitAction(sess.currentSeat, any), 'game-finished');
  });

  it('legalActions 仅当前玩家非空；snapshot 视角过滤（他人手牌只见张数、无 rngState）', () => {
    const db = openDb(':memory:');
    const sess = new GameSession(db, 'g5', 3, 11, seatsFor(3));
    const current = sess.currentSeat;

    const snapCurrent = sess.snapshotFor(current);
    expect(snapCurrent.seq).toBe(0);
    expect(snapCurrent.legalActions.length).toBeGreaterThan(0);
    expect(snapCurrent.state.players[current]!.hand.kind).toBe('full');

    for (const seat of [0, 1, 2] as PlayerIndex[]) {
      const snap = sess.snapshotFor(seat);
      if (seat === current) continue;
      expect(snap.legalActions).toEqual([]);
      expect(snap.state.players[seat]!.hand.kind).toBe('full'); // 自己的手牌仍完整
    }
    // 视角内他人手牌只见张数；序列化不含 rngState（防推算洗牌）
    const other = ((current + 1) % 3) as PlayerIndex;
    expect(snapCurrent.state.players[other]!.hand).toEqual({ kind: 'count', count: 8 });
    expect(JSON.stringify(snapCurrent.state)).not.toContain('rngState');
  });

  it('submitAction 返回递增 seq（0 起）；snapshot.seq 同步推进', () => {
    const db = openDb(':memory:');
    const sess = new GameSession(db, 'g6', 2, 7, seatsFor(2));

    for (let expected = 0; expected < 3; expected++) {
      const a = sess.snapshotFor(sess.currentSeat).legalActions[0]!;
      expect(sess.submitAction(sess.currentSeat, a)).toEqual({ seq: expected });
      expect(sess.snapshotFor(sess.currentSeat).seq).toBe(expected + 1);
    }
    expect(listActions(db, 'g6').map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  it('gameId 缺省时 crypto 生成（g_ 前缀），显式传入则原样使用', () => {
    const db = openDb(':memory:');
    const a = new GameSession(db, undefined, 2, 7, seatsFor(2, 'ga'));
    const b = new GameSession(db, undefined, 2, 8, seatsFor(2, 'gb'));
    expect(a.gameId).toMatch(/^g_[A-Za-z0-9_-]{11}$/);
    expect(b.gameId).toMatch(/^g_[A-Za-z0-9_-]{11}$/);
    expect(a.gameId).not.toBe(b.gameId);

    const c = new GameSession(db, 'explicit-id', 2, 9, seatsFor(2, 'gc'));
    expect(c.gameId).toBe('explicit-id');
    expect(generateGameId()).toMatch(/^g_[A-Za-z0-9_-]{11}$/);
  });

  it('座位参数非法：seats 与 playerCount 不匹配抛 invalid-seats；越界 seat 抛 invalid-seat', () => {
    const db = openDb(':memory:');
    expectSessionError(
      () => new GameSession(db, 'g7', 2, 7, seatsFor(3)),
      'invalid-seats',
    );
    const sess = new GameSession(db, 'g8', 2, 7, seatsFor(2));
    expectSessionError(
      () => sess.snapshotFor(5 as PlayerIndex),
      'invalid-seat',
    );
    expectSessionError(
      () => sess.submitAction(5 as PlayerIndex, { type: 'pass', cardId: 'x' }),
      'invalid-seat',
    );
  });

  it('2p/3p 整局随机对局同样通过重放校验', () => {
    for (const [pc, seed] of [[2, 5], [3, 6]] as const) {
      const db = openDb(':memory:');
      const sess = new GameSession(db, `g-pc${pc}`, pc, seed, seatsFor(pc));
      playRandomGame(sess, seed + 100);
      const rows = listActions(db, `g-pc${pc}`);
      let s: GameState = newGame(pc, seed);
      for (const row of rows) s = applyAction(s, row.action);
      const row = readGameRow(db, `g-pc${pc}`);
      expect(stableStringify(JSON.parse(row!.finalState!))).toBe(stableStringify(s));
    }
  });
});
