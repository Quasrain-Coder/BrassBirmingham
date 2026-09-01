/**
 * 时代切换审计：运河→铁路瞬间未翻面板块（L1 未翻面将被移除=纯亏）
 * + 铁路终局未翻面明细。
 * 用法: npx vite-node bench/eraend-audit.ts <spec> [局数=20]
 */
import {
  applyAction,
  enumerateActions,
  newGame,
  type GameState,
} from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const SPEC = process.argv[2] ?? 'builtin:jsb-v20260831';
const GAMES = Number(process.argv[3] ?? 20);

interface TileRec {
  era: string;
  industry: string;
  level: number;
  vp: number;
  cost: number;
  resources: number;
}

function unflippedOf(state: GameState, era: string): TileRec[] {
  const out: TileRec[] = [];
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && !t.flipped) {
        out.push({
          era,
          industry: t.tile.industry,
          level: t.tile.level,
          vp: t.tile.vp,
          cost: t.tile.costMoney,
          resources: t.resources,
        });
      }
    }
  }
  return out;
}

async function playOne(seed: number): Promise<{ canalEnd: TileRec[]; gameEnd: TileRec[] }> {
  const agents = Array.from({ length: 4 }, (_, seat) => createAgent(SPEC, { seat }));
  let state = newGame(4, seed);
  let steps = 0;
  let canalEnd: TileRec[] | null = null;
  while (state.phase !== 'game-over') {
    const prev = state;
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    const { action } = await agents[player]!.decide(state, player, legal);
    state = applyAction(state, action);
    if (canalEnd === null && prev.era === 'canal' && state.era === 'rail') {
      // prev = 清算前（L1 尚未移除）：其中的未翻面 L1 将被移除、L2+ 带入铁路
      canalEnd = unflippedOf(prev, 'canal-end');
    }
    if (++steps > 100_000) throw new Error('runaway');
  }
  return { canalEnd: canalEnd ?? [], gameEnd: unflippedOf(state, 'game-end') };
}

function report(title: string, rows: TileRec[], games: number): void {
  console.log(`\n== ${title} ==`);
  const byKey = new Map<string, { n: number; vp: number; res: number }>();
  for (const r of rows) {
    const k = `${r.industry} L${r.level}`;
    const e = byKey.get(k) ?? { n: 0, vp: 0, res: 0 };
    e.n += 1;
    e.vp += r.vp;
    e.res += r.resources;
    byKey.set(k, e);
  }
  for (const [k, e] of [...byKey.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${k.padEnd(16)} 次数 ${String(e.n).padStart(3)} | 每局 ${(e.n / games).toFixed(2)} | VP 面值 ${e.vp} | 剩余方块 ${e.res}`);
  }
}

let canalRows: TileRec[] = [];
let endRows: TileRec[] = [];
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  const { canalEnd, gameEnd } = await playOne(g);
  canalRows = canalRows.concat(canalEnd);
  endRows = endRows.concat(gameEnd);
  if ((g + 1) % 5 === 0) console.log(`[${g + 1}/${GAMES}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
report(`${SPEC} 运河末未翻面（L1 将被移除=全亏；L2+ 带入铁路）`, canalRows, GAMES);
report(`${SPEC} 铁路终局未翻面`, endRows, GAMES);
