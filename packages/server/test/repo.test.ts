import { describe, expect, it } from 'vitest';
import type { Action } from '@brass/engine';
import {
  appendAction,
  createGame,
  findSeatByToken,
  finishGame,
  listActions,
  listGames,
  openDb,
} from '../src/db/repo.js';

function makeGame(id: string, tokenPrefix = 'tok') {
  return {
    id,
    roomCode: 'ABCD',
    playerCount: 2,
    seed: 42,
    config: { playerCount: 2 as const, seed: 42 },
    seats: [
      { seat: 0, nickname: 'alice', token: `${tokenPrefix}-a` },
      { seat: 1, nickname: 'bob', token: `${tokenPrefix}-b` },
    ],
  };
}

describe('db repo', () => {
  it('createGame + listGames 往返（含 seats/config JSON）', () => {
    const db = openDb(':memory:');
    createGame(db, makeGame('g1'));

    const games = listGames(db);
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      id: 'g1',
      roomCode: 'ABCD',
      playerCount: 2,
      status: 'playing',
    });
    expect(typeof games[0]!.createdAt).toBe('number');
  });

  it('appendAction + listActions 按 seq 升序，action JSON 往返一致', () => {
    const db = openDb(':memory:');
    createGame(db, makeGame('g1'));

    const a0: Action = { type: 'pass', cardId: 'c0' };
    const a1: Action = { type: 'loan', cardId: 'c1' };
    // 乱序插入，验证读取按 seq 升序
    appendAction(db, 'g1', 1, 1, a1);
    appendAction(db, 'g1', 0, 0, a0);

    const actions = listActions(db, 'g1');
    expect(actions).toEqual([
      { seq: 0, player: 0, action: a0 },
      { seq: 1, player: 1, action: a1 },
    ]);
  });

  it('finishGame 落 finalState 并把 status 置为 finished', () => {
    const db = openDb(':memory:');
    createGame(db, makeGame('g1'));
    finishGame(db, 'g1', { winner: [0], note: 'stub-final-state' });

    expect(listGames(db)[0]!.status).toBe('finished');
  });

  it('findSeatByToken 命中返回 {gameId, seat}，未命中返回 null', () => {
    const db = openDb(':memory:');
    createGame(db, makeGame('g1'));
    createGame(db, { ...makeGame('g2', 'xyz'), roomCode: 'WXYZ' });

    expect(findSeatByToken(db, 'tok-b')).toEqual({ gameId: 'g1', seat: 1 });
    expect(findSeatByToken(db, 'xyz-a')).toEqual({ gameId: 'g2', seat: 0 });
    expect(findSeatByToken(db, 'no-such-token')).toBeNull();
  });

  it('(game_id, seq) 重复 appendAction 抛错', () => {
    const db = openDb(':memory:');
    createGame(db, makeGame('g1'));
    const a: Action = { type: 'pass', cardId: 'c0' };
    appendAction(db, 'g1', 0, 0, a);

    expect(() => appendAction(db, 'g1', 0, 1, a)).toThrow();
  });

  it('token 全局唯一：跨对局重复 token 抛错', () => {
    const db = openDb(':memory:');
    createGame(db, makeGame('g1'));
    expect(() =>
      createGame(db, {
        id: 'g2',
        roomCode: 'WXYZ',
        playerCount: 2,
        seed: 7,
        config: { playerCount: 2, seed: 7 },
        seats: [
          { seat: 0, nickname: 'carol', token: 'tok-a' }, // 与 g1 冲突
          { seat: 1, nickname: 'dave', token: 'tok-c' },
        ],
      }),
    ).toThrow();
  });
});
