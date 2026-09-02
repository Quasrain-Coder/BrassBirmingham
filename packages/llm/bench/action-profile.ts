/**
 * 行动画像：统计某 spec 自对局的行动结构——贷款/研发/搜寻次数、出售批量、
 * 建造产业分布、单/双路比例。用于对照高手策略讨论找结构差异。
 * 用法: npx vite-node bench/action-profile.ts <spec> [局数=20] [种子起点=0]
 */
import { applyAction, enumerateActions, newGame, type Action } from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const SPEC = process.argv[2] ?? 'builtin:jsb-v20260831';
const GAMES = Number(process.argv[3] ?? 20);
const SEED0 = Number(process.argv[4] ?? 0);

const cnt: Record<string, number> = {};
const bump = (k: string, n = 1) => {
  cnt[k] = (cnt[k] ?? 0) + n;
};

async function playOne(seed: number): Promise<void> {
  const agents = Array.from({ length: 4 }, (_, seat) => createAgent(SPEC, { seat }));
  let state = newGame(4, seed);
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    const { action } = await agents[player]!.decide(state, player, legal);
    const a = action as Action;
    bump(`total/${state.era}`);
    bump(`${a.type}/${state.era}`);
    if (a.type === 'sell') bump(`sellBatch${a.sales.length}`);
    if (a.type === 'build') bump(`build/${a.industry}/${state.era}`);
    if (a.type === 'network') bump(a.links.length > 1 ? 'networkDouble' : 'networkSingle');
    state = applyAction(state, action);
    if (++steps > 100_000) throw new Error('runaway');
  }
}

for (let g = 0; g < GAMES; g++) await playOne(SEED0 + g);
console.log(`== ${SPEC} 4p×${GAMES} 行动画像（每局合计，4 名玩家） ==`);
for (const [k, v] of Object.entries(cnt).sort()) {
  console.log(`${k.padEnd(24)} ${(v / GAMES).toFixed(2)}/局`);
}
