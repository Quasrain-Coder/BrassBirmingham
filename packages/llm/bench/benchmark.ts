/**
 * 自对局基准：HeuristicAgent 大批量自对局，输出与 brass-assistant sweep_scores
 * 同口径统计（人均 VP / 胜者均 VP / 最高分），每 10 局报一次进度。
 * 用法: npx vite-node bench/benchmark.ts [局数=30]
 */
import {
  applyAction,
  enumerateActions,
  newGame,
  type Action,
} from '@brass/engine';
import { HeuristicAgent } from '../src/heuristic.js';
import { createAgent } from '../src/agents/registry.js';

const GAMES = Number(process.argv[2] ?? 30);
/** BENCH_SPEC=builtin:jsb-v20260831 时用插件跑（缺省 = HeuristicAgent 直连）。 */
const SPEC = process.env['BENCH_SPEC'];

async function playOne(players: 2 | 4, seed: number): Promise<number[]> {
  const agents = SPEC
    ? Array.from({ length: players }, (_, seat) => createAgent(SPEC, { seat }))
    : Array.from({ length: players }, () => new HeuristicAgent());
  let state = newGame(players, seed);
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    if (legal.length === 0) throw new Error(`no legal at ${steps}`);
    const a: Action = SPEC
      ? (await agents[player]!.decide(state, player, legal)).action
      : (agents[player] as HeuristicAgent).chooseAction(state, legal);
    state = applyAction(state, a);
    if (++steps > 100_000) throw new Error('runaway');
  }
  return state.players.map((p) => p.vp);
}

async function stats(players: 2 | 4) {
  const t0 = Date.now();
  const all: number[][] = [];
  for (let g = 0; g < GAMES; g++) {
    all.push(await playOne(players, g));
    if ((g + 1) % 10 === 0) {
      const flat = all.flat();
      const avg = flat.reduce((s, v) => s + v, 0) / flat.length;
      console.log(
        `[${players}p ${g + 1}/${GAMES}] 累计人均 ${avg.toFixed(1)} 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`,
      );
    }
  }
  const flat = all.flat();
  const winners = all.map((v) => Math.max(...v));
  const avg = flat.reduce((s, v) => s + v, 0) / flat.length;
  const wAvg = winners.reduce((s, v) => s + v, 0) / winners.length;
  const wMax = Math.max(...winners);
  const pMax = Math.max(...flat);
  console.log(
    `${players}p × ${GAMES}: 人均 ${avg.toFixed(1)} | 胜者均 ${wAvg.toFixed(1)} | 胜者最高 ${wMax} | 单人最高 ${pMax} | ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}

await stats(4);
await stats(2);
