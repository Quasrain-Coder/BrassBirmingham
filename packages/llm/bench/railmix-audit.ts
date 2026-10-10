/**
 * 铁路时代行为审计：自对局统计 rail 期动作构成——造煤/修路(分值/走廊)/
 * 高值可售建造/卖出/研发/贷款，人均与局均。验证 AI 版本是否仍有
 * "造煤多/垃圾路/不建高值不卖货"的病灶。
 * 用法: npx vite-node bench/railmix-audit.ts <spec> [局数=10] [seed0=0]
 * 例: npx vite-node bench/railmix-audit.ts builtin:jsb-v20260911 10
 */
import { applyAction, enumerateActions, newGame, LINKS, LOCATIONS } from '@brass/engine';
import type { Action, GameState } from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const SPEC = process.argv[2] ?? 'builtin:jsb-v20260911';
const GAMES = Number(process.argv[3] ?? 10);
const SEED0 = Number(process.argv[4] ?? 0);
const CORRIDOR = new Set(['stoke-on-trent', 'stone', 'uttoxeter', 'derby', 'burton-on-trent', 'belper']);

interface Mix {
  coal: number; iron: number; brewery: number; sellable: number; sellableL3: number;
  links: number; linkVpSum: number; corridor: number; junkLinks: number; // junk: 终局 <3vp
  sells: number; sellVp: number; develops: number; loans: number;
  unflippedVp: number; score: number;
}

function linkEndVp(state: GameState, linkIndex: number): number {
  const l = LINKS[linkIndex]!;
  const cnt = (x: string): number => (state.board.slots[x] ?? []).filter((t) => t !== null).length;
  return (LOCATIONS[l.a] ? cnt(l.a) : 0) + (LOCATIONS[l.b] ? cnt(l.b) : 0);
}

async function playOne(seed: number): Promise<Mix[]> {
  const agents = Array.from({ length: 4 }, (_, seat) => createAgent(SPEC, { seat }));
  let state = newGame(4, seed);
  const mixes: Mix[] = Array.from({ length: 4 }, () => ({
    coal: 0, iron: 0, brewery: 0, sellable: 0, sellableL3: 0,
    links: 0, linkVpSum: 0, corridor: 0, junkLinks: 0,
    sells: 0, sellVp: 0, develops: 0, loans: 0, unflippedVp: 0, score: 0,
  }));
  const netRecs: { player: number; li: number }[] = [];
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    if (legal.length === 0) throw new Error(`no legal at ${steps}`);
    const { action } = (await agents[player]!.decide(state, player, legal)) as { action: Action };
    if (state.era === 'rail') {
      const m = mixes[player]!;
      if (action.type === 'build') {
        if (action.industry === 'coal') m.coal++;
        else if (action.industry === 'iron') m.iron++;
        else if (action.industry === 'brewery') m.brewery++;
        else {
          m.sellable++;
          const tile = state.players[player]!.tiles.find((t) => t.industry === action.industry);
          if (tile && tile.level >= 3) m.sellableL3++;
        }
      } else if (action.type === 'network') {
        for (const li of action.links) netRecs.push({ player, li });
      } else if (action.type === 'sell') {
        m.sells += action.sales.length;
        for (const s of action.sales) {
          const t = state.board.slots[s.location]?.[s.slotIndex];
          if (t) m.sellVp += t.tile.vp;
        }
      } else if (action.type === 'develop') m.develops += action.removals.length;
      else if (action.type === 'loan') m.loans++;
    }
    state = applyAction(state, action);
    if (++steps > 100_000) throw new Error('runaway');
  }
  for (const r of netRecs) {
    const m = mixes[r.player]!;
    m.links++;
    const vp = linkEndVp(state, r.li);
    m.linkVpSum += vp;
    if (vp < 3) m.junkLinks++;
    if ([LINKS[r.li]!.a, LINKS[r.li]!.b].some((x) => CORRIDOR.has(x))) m.corridor++;
  }
  for (let pid = 0; pid < 4; pid++) {
    const m = mixes[pid]!;
    m.score = state.players[pid]!.vp;
    for (const slots of Object.values(state.board.slots)) {
      for (const t of slots) {
        if (t && t.player === pid && !t.flipped) m.unflippedVp += t.tile.vp;
      }
    }
  }
  return mixes;
}

const agg = { coal: 0, iron: 0, brewery: 0, sellable: 0, sellableL3: 0, links: 0, linkVpSum: 0, corridor: 0, junkLinks: 0, sells: 0, sellVp: 0, develops: 0, loans: 0, unflippedVp: 0, score: 0 };
for (let g = 0; g < GAMES; g++) {
  const mixes = await playOne(SEED0 + g);
  for (const m of mixes) for (const k of Object.keys(agg) as (keyof typeof agg)[]) agg[k] += m[k];
  if ((g + 1) % 5 === 0) console.log(`[${g + 1}/${GAMES}]`);
}
const n = GAMES * 4;
console.log(`\n${SPEC} × ${GAMES} 局（人均 / 局均4人合计）:`);
console.log(`  均分 ${(agg.score / n).toFixed(1)} | 未翻面面值 ${(agg.unflippedVp / n).toFixed(1)}vp`);
console.log(`  铁路造煤 ${(agg.coal / n).toFixed(2)}（局均 ${(agg.coal / GAMES).toFixed(1)}）| 铁 ${(agg.iron / n).toFixed(2)} | 酒 ${(agg.brewery / n).toFixed(2)}`);
console.log(`  铁路建可售 ${(agg.sellable / n).toFixed(2)}（其中 L3+ ${(agg.sellableL3 / n).toFixed(2)}）| 卖出 ${(agg.sells / n).toFixed(2)} 块（均面值 ${agg.sells > 0 ? (agg.sellVp / agg.sells).toFixed(1) : '-'}vp）`);
console.log(`  铁路修路 ${(agg.links / n).toFixed(2)} 条（均 ${agg.links > 0 ? (agg.linkVpSum / agg.links).toFixed(1) : '-'}vp/条）| 走廊 ${(agg.corridor / n).toFixed(2)} | <3vp 垃圾路 ${(agg.junkLinks / n).toFixed(2)}`);
console.log(`  铁路研发 ${(agg.develops / n).toFixed(2)} | 贷款 ${(agg.loans / n).toFixed(2)}`);
