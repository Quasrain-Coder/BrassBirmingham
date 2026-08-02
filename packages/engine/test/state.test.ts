import { describe, expect, it } from 'vitest';
import { newGame } from '../src/state.js';
import { stableStringify } from '../src/serialize.js';
import { MERCHANTS } from '../src/data/board.js';
import type { MerchantId } from '../src/types.js';

describe('newGame', () => {
  it('4p initial state', () => {
    const s = newGame(4, 123);
    expect(s.players).toHaveLength(4);
    for (const p of s.players) {
      expect(p.money).toBe(17);
      expect(p.incomeSpace).toBe(10);
      expect(p.hand).toHaveLength(8);
      expect(p.tiles).toHaveLength(45);
    }
    expect(s.coalMarket).toBe(13);
    expect(s.ironMarket).toBe(8);
    expect(s.deck.length).toBe(64 - 4 * 8 - 1); // 发牌 + 弃牌堆底
    expect(s.discard).toHaveLength(1);
    expect(s.round).toBe(1);
    expect(s.era).toBe('canal');
  });

  it('2p merchants: warrington & nottingham empty', () => {
    const s = newGame(2, 7);
    expect(s.merchants.warrington.tiles).toHaveLength(0);
    expect(s.merchants.nottingham.tiles).toHaveLength(0);
    const total = Object.values(s.merchants).reduce((n, m) => n + m.tiles.length, 0);
    expect(total).toBe(5);
  });

  it('3p merchants: nottingham empty, 7 tiles total', () => {
    const s = newGame(3, 7);
    expect(s.merchants.nottingham.tiles).toHaveLength(0);
    const total = Object.values(s.merchants).reduce((n, m) => n + m.tiles.length, 0);
    expect(total).toBe(7);
  });

  it('4p merchants: all 9 tiles placed, beer=1 per non-blank tile', () => {
    const s = newGame(4, 7);
    const total = Object.values(s.merchants).reduce((n, m) => n + m.tiles.length, 0);
    expect(total).toBe(9);
    for (const [id, m] of Object.entries(s.merchants)) {
      expect(m.tiles.length).toBe(MERCHANTS[id as MerchantId].slots);
      expect(m.beer).toBe(m.tiles.filter((t) => t !== 'blank').length);
    }
  });

  it('merchant tile composition per player count', () => {
    const count = (n: 2 | 3 | 4, tile: string) =>
      Object.values(newGame(n, 5).merchants)
        .flatMap((m) => m.tiles)
        .filter((t) => t === tile).length;
    expect(count(2, 'any')).toBe(1);
    expect(count(2, 'cotton')).toBe(1);
    expect(count(2, 'manufacturer')).toBe(1);
    expect(count(2, 'pottery')).toBe(0);
    expect(count(2, 'blank')).toBe(2);
    expect(count(3, 'pottery')).toBe(1);
    expect(count(3, 'blank')).toBe(3);
    expect(count(4, 'cotton')).toBe(2);
    expect(count(4, 'manufacturer')).toBe(2);
  });

  it('same seed identical setup; different seed differs', () => {
    expect(stableStringify(newGame(4, 42))).toBe(stableStringify(newGame(4, 42)));
    expect(stableStringify(newGame(4, 42))).not.toBe(stableStringify(newGame(4, 43)));
  });

  it('player tile stacks sorted by level ascending per industry', () => {
    const s = newGame(4, 1);
    const cottonLevels = s.players[0]!.tiles
      .filter((t) => t.industry === 'cotton')
      .map((t) => t.level);
    expect(cottonLevels).toEqual([...cottonLevels].sort((a, b) => a - b));
  });

  it('initial turn/phase fields', () => {
    const s = newGame(3, 99);
    expect(s.turnOrder.slice().sort()).toEqual([0, 1, 2]);
    expect(s.currentPlayerIdx).toBe(0);
    expect(s.actionsThisTurn).toBe(0);
    expect(s.lastEvents).toEqual([]);
    expect(s.phase).toBe('action');
    expect(s.winner).toBeNull();
    expect(s.board.links).toEqual([]);
    for (const slots of Object.values(s.board.slots)) {
      expect(slots.every((x) => x === null)).toBe(true);
    }
  });
});
