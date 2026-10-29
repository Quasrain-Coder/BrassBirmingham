/**
 * 插件对抗基准：两个 AI spec 轮换座位同局对抗，输出各自人均 VP 与胜率。
 * 用法: npx vite-node bench/head2head.ts <specA> <specB> [局数=40]
 * 例: npx vite-node bench/head2head.ts builtin:lm-heuristic-v20260826 builtin:jsb-v20260831 40
 */
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const SPEC_A = process.argv[2] ?? 'builtin:lm-heuristic-v20260826';
const SPEC_B = process.argv[3] ?? 'builtin:jsb-v20260831';
const GAMES = Number(process.argv[4] ?? 40);
/** argv[5]: 种子起点（并发分段用，缺省 0）。 */
const SEED0 = Number(process.argv[5] ?? 0);

const PAIRED = process.env['PAIRED'] === '1';

async function playOne(seed: number, swap: boolean): Promise<{ vps: number[]; specs: string[] }> {
  // 4p：A/B/A/B；swap 或（非配对模式下）奇数局交换首座位，防顺位偏差
  const swapped = PAIRED ? swap : seed % 2 === 1;
  const specs = !swapped ? [SPEC_A, SPEC_B, SPEC_A, SPEC_B] : [SPEC_B, SPEC_A, SPEC_B, SPEC_A];
  const agents = specs.map((spec, seat) => createAgent(spec, { seat }));
  let state = newGame(4, seed);
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    if (legal.length === 0) throw new Error(`no legal at ${steps}`);
    const decisionStart = Date.now();
    console.log(`step ${seed}: begin=${steps + 1} era=${state.era} round=${state.round} seat=${player} spec=${specs[player]} legal=${legal.length}`);
    const { action, reason, degraded, usage } = await agents[player]!.decide(state, player, legal);
    console.log(`step ${seed}: decided=${steps + 1} seat=${player} elapsed=${((Date.now() - decisionStart) / 1000).toFixed(1)}s degraded=${degraded} usage=${usage.input}/${usage.output} reason=${reason}`);
    state = applyAction(state, action);
    steps += 1;
    console.log(`step ${seed}: applied=${steps} era=${state.era} round=${state.round} phase=${state.phase}`);
    if (steps > 100_000) throw new Error('runaway');
  }
  return { vps: state.players.map((p) => p.vp), specs };
}

const sum: Record<string, { vp: number; n: number; wins: number; pts: number }> = {};
for (const s of [SPEC_A, SPEC_B]) sum[s] = { vp: 0, n: 0, wins: 0, pts: 0 };
const t0 = Date.now();
let total = 0;
for (let g = 0; g < GAMES; g++) {
  // PAIRED=1：同一种子跑 ABAB+BABA 两局完全配对，座位优势精确对消（同代码必 50%）
  const swaps = PAIRED ? [false, true] : [false]; // 非配对时 playOne 按种子奇偶自定
  for (const swap of swaps) {
    const { vps, specs } = await playOne(SEED0 + g, swap);
    total += 1;
    const winVp = Math.max(...vps);
    console.log(`game ${g}${PAIRED ? (swap ? '· swapped' : '· mirror') : ''}: ${specs.map((s, i) => `${s === SPEC_A ? 'A' : 'B'}=${vps[i]}`).join(' ')}`);
    // 名次积分 v2（2026-10-16，零和制）：(1,2)+4 / (3,4)-4，(1,3)+2 / (2,4)-2，
    // (1,4)/(2,3)=0；同分按座位序破平（严格名次 1-4，保证每局两队积分和恒 0；
    // 座位布局 ABAB/BABA 随种子轮换，破平偏差在批次内对消）。
    const order = [0, 1, 2, 3].sort((a, b) => vps[b]! - vps[a]! || a - b);
    const rank = [0, 0, 0, 0];
    order.forEach((i, pos) => {
      rank[i] = pos + 1;
    });
    const RANK_PTS: Record<string, number> = { '1,2': 4, '3,4': -4, '1,3': 2, '2,4': -2 };
    for (const spec of [SPEC_A, SPEC_B]) {
      const ranks = rank.filter((_, i) => specs[i] === spec).sort((a, b) => a - b);
      sum[spec]!.pts += RANK_PTS[ranks.join(',')] ?? 0;
    }
    for (let i = 0; i < 4; i++) {
      const s = sum[specs[i]!]!;
      s.vp += vps[i]!;
      s.n += 1;
      if (vps[i] === winVp) s.wins += 1;
    }
  }
  if ((g + 1) % 10 === 0) {
    console.log(`[${g + 1}/${GAMES}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
for (const [spec, s] of Object.entries(sum)) {
  console.log(`${spec}: 人均 ${(s.vp / s.n).toFixed(1)} | 胜率 ${((s.wins / total) * 100).toFixed(0)}% (${s.wins}/${total}) | 名次积分 ${(s.pts / total).toFixed(3)}/局 (总 ${s.pts})`);
}
// 合入判定（B=候选侧）：名次积分均值与人均 VP 双高 → 可合入（2026-10-16 新规矩，不强求 55% 胜率）。
const a = sum[SPEC_A]!;
const b = sum[SPEC_B]!;
const ptsHigh = b.pts > a.pts;
const vpHigh = b.vp / b.n > a.vp / a.n;
console.log(`合入判定（B 对 A）: 名次积分 ${ptsHigh ? '高' : '低'}（${(b.pts / total).toFixed(3)} vs ${(a.pts / total).toFixed(3)}），人均 VP ${vpHigh ? '高' : '低'}（${(b.vp / b.n).toFixed(1)} vs ${(a.vp / a.n).toFixed(1)}）→ ${ptsHigh && vpHigh ? '✅ 可合入' : '✗ 不合入'}`);
