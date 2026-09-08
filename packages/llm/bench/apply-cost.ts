/** applyAction 成本分解：按时代/动作类型测量，定位 2ms/call 的来源。 */
import { applyAction, enumerateActions, newGame, type Action, type GameState } from '@brass/engine';

function playTo(seed: number, steps: number): GameState {
  let s: GameState = newGame(4, seed);
  for (let i = 0; i < steps && s.phase !== 'game-over'; i++) {
    const p = s.turnOrder[s.currentPlayerIdx]!;
    const legal = enumerateActions(s, p);
    s = applyAction(s, legal[i % legal.length === 0 ? 0 : 0]!);
  }
  return s;
}

// 收集不同阶段的状态：运河早期(10步)/运河末(60步)/铁路中(90步)/铁路末(115步)
const states: [string, GameState][] = [
  ['canal-early(10)', playTo(7, 10)],
  ['canal-late(60)', playTo(7, 60)],
  ['rail-mid(90)', playTo(7, 90)],
  ['rail-late(115)', playTo(7, 115)],
];

for (const [label, s] of states) {
  const p = s.turnOrder[s.currentPlayerIdx]!;
  const legal = enumerateActions(s, p);
  // 按类型各取第一个动作测 100 次
  const byType = new Map<string, Action>();
  for (const a of legal) if (!byType.has(a.type)) byType.set(a.type, a);
  const parts: string[] = [`${label} (${legal.length} legal, era=${s.era}):`];
  for (const [type, action] of byType) {
    const t0 = performance.now();
    const N = 100;
    for (let i = 0; i < N; i++) applyAction(s, action);
    parts.push(`  ${type}: ${((performance.now() - t0) / N).toFixed(3)}ms`);
  }
  console.log(parts.join('\n'));
}

// 长链推演场景：连续 apply 500 步（模拟 rollout 环境），测单步成本随步数变化
let s = playTo(7, 40);
const costs: number[] = [];
for (let i = 0; i < 400 && s.phase !== 'game-over'; i++) {
  const p = s.turnOrder[s.currentPlayerIdx]!;
  const legal = enumerateActions(s, p);
  const t0 = performance.now();
  s = applyAction(s, legal[0]!);
  costs.push(performance.now() - t0);
}
costs.sort((a, b) => a - b);
console.log(`rollout 连续 apply ${costs.length} 步: avg ${(costs.reduce((x, y) => x + y, 0) / costs.length).toFixed(3)}ms p50 ${costs[Math.floor(costs.length / 2)]!.toFixed(3)} p95 ${costs[Math.floor(costs.length * 0.95)]!.toFixed(3)} max ${costs[costs.length - 1]!.toFixed(3)}`);
