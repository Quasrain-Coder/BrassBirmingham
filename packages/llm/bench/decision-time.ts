/**
 * 逐步决策耗时画像：对指定 spec 打 N 局（可 self-play），统计每个 decide 的
 * wall time（avg/p50/p95/max）+ ISMCTS 分段计时构成。
 * 用法: npx vite-node bench/decision-time.ts <spec> [局数=2] [种子=80000] [对手spec]
 */
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';
import { ISMCTS_PROFILE, resetIsmctsProfile } from '../src/agents/heuristic-core.js';

const SPEC = process.argv[2] ?? 'builtin:jsb-v20260907';
const GAMES = Number(process.argv[3] ?? 2);
const SEED0 = Number(process.argv[4] ?? 80000);
const OPP = process.argv[5] ?? SPEC;

const times: number[] = [];
resetIsmctsProfile();
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  const specs = g % 2 === 0 ? [SPEC, OPP, SPEC, OPP] : [OPP, SPEC, OPP, SPEC];
  const agents = specs.map((spec, seat) => createAgent(spec, { seat }));
  let state = newGame(4, SEED0 + g);
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    const d0 = performance.now();
    const { action } = await agents[player]!.decide(state, player, legal);
    times.push(performance.now() - d0);
    state = applyAction(state, action);
    if (++steps > 100_000) throw new Error('runaway');
  }
}
times.sort((a, b) => a - b);
const sum = times.reduce((s, x) => s + x, 0);
const pct = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))]!;
console.log(`== ${SPEC} vs ${OPP}，${GAMES} 局 ${times.length} 步，总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s ==`);
console.log(`每步: avg ${(sum / times.length).toFixed(0)}ms | p50 ${pct(0.5).toFixed(0)} | p95 ${pct(0.95).toFixed(0)} | p99 ${pct(0.99).toFixed(0)} | max ${times[times.length - 1]!.toFixed(0)}`);
console.log(`>5s 步数: ${times.filter((t) => t > 5000).length} | >10s 步数: ${times.filter((t) => t > 10000).length}`);
const P = ISMCTS_PROFILE;
const total = P.determinizeMs + P.rolloutScoreMs + P.rolloutCtxMs + P.rolloutApplyMs + P.leafMs;
console.log(`ISMCTS: 触发 ${P.triggers} 次 / 模拟 ${P.sims} 次（每次触发均 ${(P.sims / Math.max(1, P.triggers)).toFixed(1)} 模拟）`);
console.log(`  determinize ${P.determinizeMs.toFixed(0)}ms (${((P.determinizeMs / total) * 100).toFixed(1)}%)`);
console.log(`  rollout-score ${P.rolloutScoreMs.toFixed(0)}ms (${((P.rolloutScoreMs / total) * 100).toFixed(1)}%)`);
console.log(`  rollout-ctx ${P.rolloutCtxMs.toFixed(0)}ms (${((P.rolloutCtxMs / total) * 100).toFixed(1)}%)`);
console.log(`  rollout-apply ${P.rolloutApplyMs.toFixed(0)}ms (${((P.rolloutApplyMs / total) * 100).toFixed(1)}%)`);
console.log(`  leaf-eval ${P.leafMs.toFixed(0)}ms (${((P.leafMs / total) * 100).toFixed(1)}%)`);
if (P.sims > 0) console.log(`  单次模拟均 ${(total / P.sims).toFixed(1)}ms | 单次触发均 ${(total / Math.max(1, P.triggers)).toFixed(0)}ms`);
