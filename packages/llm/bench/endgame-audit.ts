/**
 * 终局审计：统计某 spec 自对局终局时场上**未翻面**板块分布——
 * 重点看"贵板块/酒厂造了却没翻面"（白花的建造动作与资源）。
 * 用法: npx vite-node bench/endgame-audit.ts <spec> [局数=20]
 */
import {
  applyAction,
  enumerateActions,
  newGame,
  type IndustryType,
  type PlayerIndex,
} from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const SPEC = process.argv[2] ?? 'builtin:heuristic-v20260829';
const GAMES = Number(process.argv[3] ?? 20);

interface UnflippedRec {
  industry: IndustryType;
  level: number;
  costMoney: number;
  vp: number;
  resources: number; // 酒厂/矿剩余方块
  owner: PlayerIndex;
}

async function playOne(seed: number): Promise<UnflippedRec[]> {
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
  const out: UnflippedRec[] = [];
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && !t.flipped) {
        out.push({
          industry: t.tile.industry,
          level: t.tile.level,
          costMoney: t.tile.costMoney,
          vp: t.tile.vp,
          resources: t.resources,
          owner: t.player,
        });
      }
    }
  }
  return out;
}

const byKey = new Map<string, { n: number; costSum: number; vpSum: number; resSum: number }>();
let totalGames = 0;
let totalUnflipped = 0;
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  const recs = await playOne(g);
  totalGames += 1;
  totalUnflipped += recs.length;
  for (const r of recs) {
    const k = `${r.industry} L${r.level}`;
    const e = byKey.get(k) ?? { n: 0, costSum: 0, vpSum: 0, resSum: 0 };
    e.n += 1;
    e.costSum += r.costMoney;
    e.vpSum += r.vp;
    e.resSum += r.resources;
    byKey.set(k, e);
  }
  if ((g + 1) % 5 === 0) console.log(`[${g + 1}/${GAMES}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log(`\n== ${SPEC} 4p×${totalGames} 终局未翻面板块（含资源类余量>0 即未翻） ==`);
const rows = [...byKey.entries()].sort((a, b) => b[1].n - a[1].n);
for (const [k, e] of rows) {
  console.log(
    `${k.padEnd(16)} 次数 ${String(e.n).padStart(3)} | 每局 ${(e.n / totalGames).toFixed(2)} | 平均造价 £${(e.costSum / e.n).toFixed(1)} | 累计损失 VP 面值 ${e.vpSum} | 剩余方块 ${e.resSum}`,
  );
}
console.log(`总计 ${totalUnflipped} 块未翻面（每局 ${(totalUnflipped / totalGames).toFixed(1)} 块 = 每位玩家 ${(totalUnflipped / totalGames / 4).toFixed(2)} 块）`);
