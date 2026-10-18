/**
 * playbook 触发率插桩台架（E28b 机制待查）：跑 N 局自对弈，
 * 读 heuristic-core 的 PB_STATS，回答：
 *   1. 检测率：多少比例的座位被判定 cotton3（E28b 假设 ~12% → 效应稀释）；
 *   2. 决策翻转率：boost 实际改变 argmax 的比例（低=估值本来就偏向棉，
 *      加权是空转；高=加权真在改行为）。
 * 用法: npx vite-node bench/playbook-instrument.ts [spec] [局数=12] [seed0=5000]
 */
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';
import { PB_STATS } from '../src/agents/heuristic-core.js';

const SPEC = process.argv[2] ?? 'builtin:zjk-v20261016-playbook-cotton';
const GAMES = Number(process.argv[3] ?? 12);
const SEED0 = Number(process.argv[4] ?? 5000);

async function playOne(seed: number) {
  const agents = Array.from({ length: 4 }, (_, seat) => createAgent(SPEC, { seat }));
  let state = newGame(4, seed);
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    const { action } = await agents[player]!.decide(state, player, legal);
    state = applyAction(state, action);
    if (++steps > 100_000) throw new Error('runaway');
  }
  return state.players.map((p) => p.vp);
}

const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  await playOne(SEED0 + g);
  if ((g + 1) % 3 === 0)
    console.log(
      `[${g + 1}/${GAMES}] ${((Date.now() - t0) / 1000).toFixed(0)}s 检测 ${PB_STATS.detected}/${PB_STATS.agents} 加权 ${PB_STATS.boostedActions} 翻转 ${PB_STATS.flippedDecisions}`,
    );
}
console.log(`\n== playbook 插桩结果（${SPEC} ×${GAMES} 局） ==`);
console.log(`座位检测率: ${PB_STATS.detected}/${PB_STATS.agents} = ${(100 * PB_STATS.detected / PB_STATS.agents).toFixed(1)}%`);
console.log(`加权动作数(全程): ${PB_STATS.boostedActions}`);
console.log(`决策翻转数(全程): ${PB_STATS.flippedDecisions}`);
console.log(`翻转/加权比: ${(100 * PB_STATS.flippedDecisions / Math.max(1, PB_STATS.boostedActions)).toFixed(2)}%`);
