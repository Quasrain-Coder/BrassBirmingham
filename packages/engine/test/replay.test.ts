/**
 * 重放一致性：playGame 记录的 action log，用 newGame(同种子) + 逐条 applyAction
 * 纯重放（无 agent、无随机源介入），终态必须与原局逐字节一致（stableStringify）。
 * 覆盖 4p/3p/2p 三种人数。
 */
import { describe, expect, it } from 'vitest';
import { playGame } from '../src/agents/random.js';
import { applyAction } from '../src/apply.js';
import { stableStringify } from '../src/serialize.js';
import { newGame } from '../src/state.js';

describe('replay', () => {
  it('replay: re-applying logged actions reproduces byte-identical final state (4p, 20 games)', () => {
    for (let seed = 0; seed < 20; seed++) {
      const { state: final1, log } = playGame(4, seed);
      let s = newGame(4, seed);
      for (const a of log) s = applyAction(s, a);
      expect(stableStringify(s)).toBe(stableStringify(final1));
    }
  });

  it('replay: 3p and 2p (10 games each)', () => {
    for (let seed = 0; seed < 10; seed++) {
      for (const pc of [2, 3] as const) {
        const { state: final1, log } = playGame(pc, seed);
        let s = newGame(pc, seed);
        for (const a of log) s = applyAction(s, a);
        expect(stableStringify(s)).toBe(stableStringify(final1));
      }
    }
  });
});
