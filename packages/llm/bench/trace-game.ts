/**
 * 单局决策流水：打印每动 座位(spec) 行动 现金/VP 轨迹，供败局复盘。
 * 用法: npx vite-node bench/trace-game.ts <seed> [specA] [specB]
 */
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';
import { describeAction } from '../src/summarize.js';

const SEED = Number(process.argv[2] ?? 0);
const SPEC_A = process.argv[3] ?? 'builtin:lm-heuristic-v20260829';
const SPEC_B = process.argv[4] ?? 'builtin:jsb-v20260831';

const specs = [SPEC_A, SPEC_B, SPEC_A, SPEC_B];
const tag = (s: string): string => (s.includes('jsb') ? 'jsb' : s.includes('0829') ? 'lm29' : 'lm26');
const agents = specs.map((spec, seat) => createAgent(spec, { seat }));
let state = newGame(4, SEED);
let steps = 0;
while (state.phase !== 'game-over') {
  const player = state.turnOrder[state.currentPlayerIdx]!;
  const legal = enumerateActions(state, player);
  const { action } = await agents[player]!.decide(state, player, legal);
  const eraRound = `${state.era === 'canal' ? 'C' : 'R'}${state.round}`;
  console.log(
    `${String(steps).padStart(3)} ${eraRound} P${player}(${tag(specs[player]!)}) ${describeAction(state, player, action)}`,
  );
  state = applyAction(state, action);
  if (++steps > 100_000) throw new Error('runaway');
}
console.log('终局 VP:', state.players.map((p, i) => `P${i}(${tag(specs[i]!)})=${p.vp}`).join(' '));
