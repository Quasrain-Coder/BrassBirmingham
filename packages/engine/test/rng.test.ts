import { describe, it, expect } from 'vitest';
import { createRng } from '../src/rng.js';
import { stableStringify } from '../src/serialize.js';

describe('rng', () => {
  it('same seed produces identical sequence', () => {
    const a = createRng(42), b = createRng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it('different seeds diverge', () => {
    const a = createRng(1), b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });
  it('shuffle is deterministic and a permutation', () => {
    const input = Array.from({ length: 52 }, (_, i) => i);
    const s1 = createRng(7).shuffle(input);
    const s2 = createRng(7).shuffle(input);
    expect(s1).toEqual(s2);
    expect([...s1].sort((x, y) => x - y)).toEqual(input);
    expect(input[0]).toBe(0); // 原数组不被修改
  });
});

describe('stableStringify', () => {
  it('sorts object keys', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } }))
      .toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
