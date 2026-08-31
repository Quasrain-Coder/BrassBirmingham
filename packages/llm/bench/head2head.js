/**
 * 插件对抗基准：两个 AI spec 轮换座位同局对抗，输出各自人均 VP 与胜率。
 * 用法: npx vite-node bench/head2head.ts <specA> <specB> [局数=40]
 * 例: npx vite-node bench/head2head.ts builtin:heuristic-v20260826 builtin:heuristic-v20260829 40
 */
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';
const SPEC_A = process.argv[2] ?? 'builtin:heuristic-v20260826';
const SPEC_B = process.argv[3] ?? 'builtin:heuristic-v20260829';
const GAMES = Number(process.argv[4] ?? 40);
async function playOne(seed) {
    // 4p：A/B/A/B；奇数局交换首座位，防顺位偏差
    const specs = seed % 2 === 0 ? [SPEC_A, SPEC_B, SPEC_A, SPEC_B] : [SPEC_B, SPEC_A, SPEC_B, SPEC_A];
    const agents = specs.map((spec, seat) => createAgent(spec, { seat }));
    let state = newGame(4, seed);
    let steps = 0;
    while (state.phase !== 'game-over') {
        const player = state.turnOrder[state.currentPlayerIdx];
        const legal = enumerateActions(state, player);
        if (legal.length === 0)
            throw new Error(`no legal at ${steps}`);
        const { action } = await agents[player].decide(state, player, legal);
        state = applyAction(state, action);
        if (++steps > 100_000)
            throw new Error('runaway');
    }
    return { vps: state.players.map((p) => p.vp), specs };
}
const sum = {};
for (const s of [SPEC_A, SPEC_B])
    sum[s] = { vp: 0, n: 0, wins: 0 };
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
    const { vps, specs } = await playOne(g);
    const winVp = Math.max(...vps);
    for (let i = 0; i < 4; i++) {
        const s = sum[specs[i]];
        s.vp += vps[i];
        s.n += 1;
        if (vps[i] === winVp)
            s.wins += 1;
    }
    if ((g + 1) % 10 === 0) {
        console.log(`[${g + 1}/${GAMES}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
}
for (const [spec, s] of Object.entries(sum)) {
    console.log(`${spec}: 人均 ${(s.vp / s.n).toFixed(1)} | 胜率 ${((s.wins / GAMES) * 100).toFixed(0)}% (${s.wins}/${GAMES})`);
}
