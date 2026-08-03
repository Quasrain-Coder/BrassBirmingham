/**
 * 确定性种子随机数（mulberry32）。
 * 全局约束：engine 内禁止 Date.now / Math.random，一切随机性必须来自本模块注入的种子。
 */

export interface Rng {
  /** 返回 [0, 1) 的浮点数 */
  next(): number;
  /** 返回 [0, maxExclusive) 的整数 */
  nextInt(maxExclusive: number): number;
  /** Fisher-Yates 洗牌，返回新数组，不修改入参 */
  shuffle<T>(arr: T[]): T[];
  /** 返回内部 32 位状态，用于重放校验 */
  getState(): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // 全部方法定义为闭包内函数、内部互相直接引用（不经 this）：
  // 解构调用（const { shuffle } = rng）也必须可用。
  function nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`nextInt: maxExclusive must be a positive integer, got ${maxExclusive}`);
    }
    return Math.floor(next() * maxExclusive);
  }

  function shuffle<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = nextInt(i + 1);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  }

  function getState(): number {
    return state >>> 0;
  }

  return { next, nextInt, shuffle, getState };
}
