import { describe, it, expect } from 'vitest';
import { createRng } from '../src/rng.js';
import { IllegalActionError } from '../src/errors.js';
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
  it('shuffle survives destructuring (no this binding)', () => {
    const { shuffle } = createRng(7);
    const out = shuffle([1, 2, 3, 4, 5]);
    expect([...out].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(out).toEqual(createRng(7).shuffle([1, 2, 3, 4, 5]));
  });
});

describe('rng.nextInt', () => {
  it('returns integers in [0, maxExclusive)', () => {
    const rng = createRng(9);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
    }
  });
  it('rejects non-positive or non-integer bounds', () => {
    const rng = createRng(9);
    for (const bad of [0, -1, 2.5, NaN]) {
      expect(() => rng.nextInt(bad)).toThrow(RangeError);
    }
  });
});

describe('rng.getState（重放依赖的语义）', () => {
  it('fresh rng state is the seed (uint32)', () => {
    expect(createRng(42).getState()).toBe(42);
    expect(createRng(-1).getState()).toBe(0xffffffff);
  });
  it('same call sequence from the same seed reaches the same state', () => {
    const a = createRng(42), b = createRng(42);
    const calls = (r: ReturnType<typeof createRng>) => {
      r.next();
      r.nextInt(10);
      r.shuffle([1, 2, 3, 4]);
    };
    calls(a);
    calls(b);
    expect(a.getState()).toBe(b.getState());
    // 状态相同 → 后续序列也相同（时代末重洗用 getState 续种依赖此性质）
    expect(a.next()).toBe(b.next());
  });
  it('state advances on every draw', () => {
    const rng = createRng(1);
    const s0 = rng.getState();
    rng.next();
    expect(rng.getState()).not.toBe(s0);
  });
});

describe('IllegalActionError', () => {
  it('is an Error carrying name/code/message', () => {
    const e = new IllegalActionError('illegal-action', 'not in enumerated set');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('IllegalActionError');
    expect(e.code).toBe('illegal-action');
    expect(e.message).toBe('not in enumerated set');
  });
});

describe('stableStringify', () => {
  it('sorts object keys', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } }))
      .toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
