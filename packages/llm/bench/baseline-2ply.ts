/**
 * 2-ply 基线：4 席 HeuristicAgent（prescreen 同款评分 + 2-ply 前瞻）。
 * 对照 argmax（纯 top-1）量化前瞻的价值。
 * 用法: vite-node bench/tmp-2ply-baseline.ts <seed0=5000> <games=30>
 */
import { enumerateActions, newGame, applyAction } from '@brass/engine';
import { HeuristicAgent } from '../src/heuristic.js';

const SEED0 = Number(process.argv[2] ?? 5000);
const N = Number(process.argv[3] ?? 30);

for (let i = 0; i < N; i++) {
  const seed = SEED0 + i;
  const agents = [0, 1, 2, 3].map(() => new HeuristicAgent());
  let state = newGame(4, seed);
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    const d = await agents[player]!.decide(state, player, legal);
    state = applyAction(state, d.action);
    if (++steps > 100_000) throw new Error('runaway');
  }
  console.log(`2PLY seed=${seed} vps=[${state.players.map((p) => p.vp).join(',')}]`);
}
