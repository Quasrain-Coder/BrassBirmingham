/**
 * prescreen 对齐审计：4×jsb-v20260903 纯 bot 对局 N 局，
 * 统计 bot 实际决策在 scoreAction prescreen 排名中的分布——chosenRank>20 的
 * 占比即「LLM top-20 候选窗看不到冠军级动作」的规模。bot 决策与 prescreen
 * 无关（CFG 评分器），同种子重跑决策不变、只有排名随 scorer 变化，可做
 * scorer 前后对照。
 * 用法: vite-node bench/tmp-prescreen-audit.ts <seed0=7000> <games=16>
 */
import { createAgent } from '../src/agents/registry.js';
import { driveGame } from './drive-game.js';

const SEED0 = Number(process.argv[2] ?? 7000);
const N = Number(process.argv[3] ?? 16);

const rows: { rank: number; kind: string }[] = [];
for (let i = 0; i < N; i++) {
  const agents = [0, 1, 2, 3].map((s) => createAgent('builtin:jsb-v20260903', { seat: s }));
  const g = await driveGame(4, SEED0 + i, agents);
  for (const d of g.decisions) {
    rows.push({ rank: d.chosenRank, kind: d.chosen.slice(0, 2) });
  }
  console.log(`seed ${SEED0 + i} done`);
}
let gt20 = 0;
let gt50 = 0;
const kindCounts = new Map<string, number>();
for (const r of rows) {
  if (r.rank > 20) {
    gt20 += 1;
    if (r.rank > 50) gt50 += 1;
    kindCounts.set(r.kind, (kindCounts.get(r.kind) ?? 0) + 1);
  }
}
console.log(
  JSON.stringify({
    seeds: [SEED0, SEED0 + N - 1],
    decisions: rows.length,
    gt20,
    gt50,
    share: `${((gt20 / rows.length) * 100).toFixed(2)}%`,
    gt20Kinds: [...kindCounts.entries()].sort((a, b) => b[1] - a[1]),
  }),
);
