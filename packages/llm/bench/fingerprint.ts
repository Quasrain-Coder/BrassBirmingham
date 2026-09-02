/**
 * 行为指纹：某 spec 自对局 N 局，逐局输出 VP 序列——重构前后逐字节对比，
 * 证明"配置即差异"的重构不改变任何决策。
 * 用法: npx vite-node bench/fingerprint.ts <spec> [局数=10] [种子起点=7000]
 */
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const SPEC = process.argv[2] ?? 'builtin:jsb-v20260902';
const GAMES = Number(process.argv[3] ?? 10);
const SEED0 = Number(process.argv[4] ?? 7000);

for (let g = 0; g < GAMES; g++) {
  const agents = Array.from({ length: 4 }, (_, seat) => createAgent(SPEC, { seat }));
  let state = newGame(4, SEED0 + g);
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    const { action } = await agents[player]!.decide(state, player, legal);
    state = applyAction(state, action);
    if (++steps > 100_000) throw new Error('runaway');
  }
  console.log(`${SEED0 + g}: ${state.players.map((p) => p.vp).join(',')}`);
}
