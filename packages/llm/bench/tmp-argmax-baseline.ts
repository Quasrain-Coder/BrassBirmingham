/**
 * argmax 基线：4 席全部 = prescreen Top-1（无 2-ply、无 LLM）。
 * 测「LLM 在 prescreen 候选里的自由选择」相对「无脑信评分」的真实增量。
 * 用法: vite-node bench/tmp-argmax-baseline.ts <seed0=5000> <games=10>
 */
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import { prescreen } from '../src/heuristic.js';
import { driveGame } from './drive-game.js';
import type { DecidingAgent, Decision } from '../src/decision.js';

const SEED0 = Number(process.argv[2] ?? 5000);
const N = Number(process.argv[3] ?? 10);

class ArgmaxAgent implements DecidingAgent {
  async decide(state: import('@brass/engine').GameState, player: import('@brass/engine').PlayerIndex, legal: import('@brass/engine').Action[]): Promise<Decision> {
    const top = prescreen(state, player, legal, 20)[0] ?? legal[0]!;
    return { action: top, reason: 'prescreen argmax', degraded: true, usage: { input: 0, output: 0 } };
  }
}

for (let i = 0; i < N; i++) {
  const seed = SEED0 + i;
  const agents = [0, 1, 2, 3].map((s) => new ArgmaxAgent());
  const g = await driveGame(4, seed, agents);
  console.log(`ARGMAX seed=${seed} vps=[${g.state.players.map((p) => p.vp).join(',')}]`);
}
