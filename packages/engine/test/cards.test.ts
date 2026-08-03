import { describe, expect, it } from 'vitest';
import { buildDeck } from '../src/data/cards.js';

describe('buildDeck', () => {
  it('deck sizes 40/54/64 for 2/3/4 players', () => {
    expect(buildDeck(2)).toHaveLength(40);
    expect(buildDeck(3)).toHaveLength(54);
    expect(buildDeck(4)).toHaveLength(64);
  });
  it('4p deck composition', () => {
    const deck = buildDeck(4);
    const loc = deck.filter((c) => c.kind === 'location');
    expect(loc).toHaveLength(41);
    expect(
      loc.filter((c) => c.kind === 'location' && c.location === 'birmingham'),
    ).toHaveLength(3);
    expect(
      loc.filter((c) => c.kind === 'location' && c.location === 'tamworth'),
    ).toHaveLength(1);
    const ind = deck.filter((c) => c.kind === 'industry');
    expect(ind).toHaveLength(23); // 15 单图标 + 8 双图标
    expect(
      ind.filter((c) => c.kind === 'industry' && c.industries.length === 2),
    ).toHaveLength(8);
    expect(
      ind.filter((c) => c.kind === 'industry' && c.industries[0] === 'brewery'),
    ).toHaveLength(5);
    expect(
      ind.filter((c) => c.kind === 'industry' && c.industries[0] === 'iron'),
    ).toHaveLength(4);
  });
  it('2p deck: no derbyshire/staffordshire location cards, no dual industry cards', () => {
    const deck = buildDeck(2);
    expect(
      deck.filter(
        (c) =>
          c.kind === 'location' &&
          ['leek', 'stoke-on-trent', 'stone', 'uttoxeter', 'belper', 'derby'].includes(
            (c as never as { location: string }).location,
          ),
      ),
    ).toHaveLength(0);
    expect(
      deck.filter((c) => c.kind === 'industry' && c.industries.length === 2),
    ).toHaveLength(0);
  });
  it('3p deck keeps staffordshire, drops derbyshire', () => {
    const deck = buildDeck(3);
    expect(
      deck.filter((c) => c.kind === 'location' && c.location === 'leek'),
    ).toHaveLength(2);
    expect(
      deck.filter((c) => c.kind === 'location' && c.location === 'derby'),
    ).toHaveLength(0);
  });
});
