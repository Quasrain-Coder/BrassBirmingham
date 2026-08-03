import { expect, it } from 'vitest';
import { newGame } from '@brass/engine';
import { filterStateFor } from '../src/filter.js';

it('viewer sees own hand, others only counts', () => {
  const s = newGame(4, 42);
  const f = filterStateFor(s, 0) as never as { players: { hand: { kind: string; cards?: unknown[]; count?: number } }[] };
  expect(f.players[0]!.hand.kind).toBe('full');
  expect(f.players[0]!.hand.cards).toHaveLength(8);
  for (let i = 1; i < 4; i++) {
    expect(f.players[i]!.hand.kind).toBe('count');
    expect(f.players[i]!.hand.count).toBe(8);
    expect(f.players[i]!.hand.cards).toBeUndefined();
  }
});
it('deck/discard are counts; rngState stripped; JSON-serializable', () => {
  const s = newGame(4, 42);
  const f = JSON.parse(JSON.stringify(filterStateFor(s, 0)));
  expect(f.deck.count).toBe(31);
  expect(f.discard.count).toBe(1);
  expect(f.rngState).toBeUndefined();
});
it('filtering does not mutate original state', () => {
  const s = newGame(4, 42);
  const before = JSON.stringify(s);
  filterStateFor(s, 0);
  expect(JSON.stringify(s)).toBe(before);
});
