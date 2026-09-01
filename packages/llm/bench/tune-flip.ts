/**
 * flip 引导参数扫描（内战指标）：每组配置跑 4p 自对局 N 局，
 * 输出 人均 VP + 终局未翻面可售板块 VP 面值损失/局。
 * 用法: npx vite-node bench/tune-flip.ts [局数=20]
 * 选参纪律：本表（内战）筛 top，再用 head2head（外战）定稿。
 */
import {
  applyAction,
  enumerateActions,
  newGame,
} from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const GAMES = Number(process.argv[2] ?? 20);
const SPEC = 'builtin:jsb-v20260831';

interface Cfg {
  sellWindowFull: number;
  sellWindowPerBeer: number;
  sellWindowPerVp: number;
  sellWindowPerCost: number;
  sellQueueDecay: number;
  sellQueueVpNorm: number;
}

const BASE: Cfg = {
  sellWindowFull: 4.0,
  sellWindowPerBeer: 1.0,
  sellWindowPerVp: 0.3,
  sellWindowPerCost: 0.1,
  sellQueueDecay: 0.8,
  sellQueueVpNorm: 8.0,
};

const GRID: Cfg[] = [];
for (const full of [2, 4, 6]) {
  for (const decay of [0.7, 0.8, 0.9]) {
    GRID.push({ ...BASE, sellWindowFull: full, sellQueueDecay: decay });
  }
}
// 加权消融：关啤酒/VP/造价加权各一
GRID.push({ ...BASE, sellWindowPerBeer: 0 });
GRID.push({ ...BASE, sellWindowPerVp: 0 });
GRID.push({ ...BASE, sellWindowPerCost: 0 });

interface Row {
  cfg: Cfg;
  avgVp: number;
  lossVpPerGame: number;
}

async function playOne(seed: number): Promise<{ vps: number[]; lossVp: number }> {
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
  let lossVp = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && !t.flipped && t.tile.sellable) lossVp += t.tile.vp;
    }
  }
  return { vps: state.players.map((p) => p.vp), lossVp };
}

const rows: Row[] = [];
const t0 = Date.now();
for (const [ci, cfg] of GRID.entries()) {
  process.env['BRASS_TUNE_FLIP'] = JSON.stringify(cfg);
  let vpSum = 0;
  let lossSum = 0;
  for (let g = 0; g < GAMES; g++) {
    const { vps, lossVp } = await playOne(g);
    vpSum += vps.reduce((s, v) => s + v, 0);
    lossSum += lossVp;
  }
  rows.push({ cfg, avgVp: vpSum / (GAMES * 4), lossVpPerGame: lossSum / GAMES });
  console.log(
    `[${ci + 1}/${GRID.length}] full=${cfg.sellWindowFull} decay=${cfg.sellQueueDecay}` +
      `${cfg.sellWindowPerBeer === 0 ? ' noBeerW' : ''}${cfg.sellWindowPerVp === 0 ? ' noVpW' : ''}${cfg.sellWindowPerCost === 0 ? ' noCostW' : ''}` +
      ` → 人均 ${rows[ci]!.avgVp.toFixed(1)} 损失 ${rows[ci]!.lossVpPerGame.toFixed(1)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
}
delete process.env['BRASS_TUNE_FLIP'];

console.log('\n== 扫描结果（按 人均VP - 0.5×损失 排序） ==');
const ranked = rows
  .map((r) => ({ r, score: r.avgVp - 0.5 * r.lossVpPerGame }))
  .sort((a, b) => b.score - a.score);
for (const { r, score } of ranked) {
  console.log(
    `score ${score.toFixed(1)} | full=${r.cfg.sellWindowFull} decay=${r.cfg.sellQueueDecay}` +
      ` perBeer=${r.cfg.sellWindowPerBeer} perVp=${r.cfg.sellWindowPerVp} perCost=${r.cfg.sellWindowPerCost}` +
      ` | 人均 ${r.avgVp.toFixed(1)} 损失 ${r.lossVpPerGame.toFixed(1)}`,
  );
}
