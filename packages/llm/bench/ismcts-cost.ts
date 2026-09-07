/** 微基准：ISMCTS 成本构成测量（scoreLegal / evaluatePosition / 随机推演 / 确定化）。 */
import { applyAction, enumerateActions, newGame, type GameState } from '@brass/engine';

// 构造一个中盘状态：随机打 40 步
let s: GameState = newGame(4, 42);
for (let i = 0; i < 40; i++) {
  const p = s.turnOrder[s.currentPlayerIdx]!;
  const legal = enumerateActions(s, p);
  s = applyAction(s, legal[0]!);
}
const mid = s;

function timeit(label: string, fn: () => void, iters: number): void {
  fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  console.log(`${label}: ${((performance.now() - t0) / iters).toFixed(3)} ms/iter (${iters} iters)`);
}

timeit('enumerateActions', () => void enumerateActions(mid, 0), 200);
timeit('applyAction', () => void applyAction(mid, enumerateActions(mid, 0)[0]!), 200);
timeit('structuredClone(state)', () => void structuredClone(mid), 100);

// 随机推演整局
timeit('randomRollout(整局)', () => {
  let x = mid;
  let steps = 0;
  while (x.phase !== 'game-over' && steps++ < 10000) {
    const p = x.turnOrder[x.currentPlayerIdx]!;
    const legal = enumerateActions(x, p);
    x = applyAction(x, legal[steps % legal.length]!);
  }
}, 20);
