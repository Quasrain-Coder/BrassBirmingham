/**
 * 终局差距审计：离 150+ 冠军分还差多少、差在哪。
 *
 * 用法: npx vite-node bench/endgame-gap-audit.ts [spec=builtin:jsb-v20260903] [局数=12]
 *
 * 分解口径（利用 scoreEraLinks/scoreFlippedIndustries 纯函数可重放）：
 * - linkVP  = 对终局态重跑 scoreEraLinks 的 Δvp（= 终局 Link 计分原值）
 * - flipVP  = 对终局态重跑 scoreFlippedIndustries 的 Δvp（= 终局场上翻面分）
 * - banked  = vp - linkVP - flipVP（对局中入账：翻面即时分/运河末双计/商人奖励）
 * 浪费项：
 * - 未翻面板块：块数/面值 VP/造价 £/剩余方块（含酒厂桶）
 * - 没拍下去：终局手牌数（≈未兑现的建造动作）；按产业 placed/catalog 差
 *   （含研发移除，无法从终局态区分，标 note）
 * - 余钱/收入（本规则钱不折分，纯浪费/低效信号）
 */
import {
  TILES,
  applyAction,
  enumerateActions,
  incomeLevelAt,
  newGame,
  scoreEraLinks,
  scoreFlippedIndustries,
  type IndustryType,
} from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const SPEC = process.argv[2] ?? 'builtin:jsb-v20260903';
const GAMES = Number(process.argv[3] ?? 12);

interface SeatRec {
  vp: number;
  linkVP: number;
  flipVP: number;
  banked: number;
  linkCount: number;
  money: number;
  income: number;
  hand: number;
  unflipped: { n: number; vp: number; cost: number; cubes: number; barrels: number };
  unflippedByInd: Partial<Record<IndustryType, { n: number; vp: number }>>;
  placedByInd: Partial<Record<IndustryType, number>>;
}

const catalog = new Map<IndustryType, number>();
for (const t of TILES) catalog.set(t.industry, (catalog.get(t.industry) ?? 0) + t.count);

async function playOne(seed: number): Promise<SeatRec[]> {
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
  const linkRescored = scoreEraLinks(state, false);
  const flipRescored = scoreFlippedIndustries(state);
  const seats: SeatRec[] = state.players.map((p, i) => ({
    vp: p.vp,
    linkVP: linkRescored.players[i]!.vp - p.vp,
    flipVP: flipRescored.players[i]!.vp - p.vp,
    banked: 0,
    linkCount: state.board.links.filter((l) => l.player === i).length,
    money: p.money,
    income: incomeLevelAt(p.incomeSpace),
    hand: p.hand.length,
    unflipped: { n: 0, vp: 0, cost: 0, cubes: 0, barrels: 0 },
    unflippedByInd: {},
    placedByInd: {},
  }));
  for (const seat of seats) seat.banked = seat.vp - seat.linkVP - seat.flipVP;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (!t) continue;
      const s = seats[t.player]!;
      s.placedByInd[t.tile.industry] = (s.placedByInd[t.tile.industry] ?? 0) + 1;
      if (!t.flipped) {
        s.unflipped.n += 1;
        s.unflipped.vp += t.tile.vp;
        s.unflipped.cost += t.tile.costMoney;
        if (t.tile.industry === 'brewery') s.unflipped.barrels += t.resources;
        else s.unflipped.cubes += t.resources;
        const e = (s.unflippedByInd[t.tile.industry] ??= { n: 0, vp: 0 });
        e.n += 1;
        e.vp += t.tile.vp;
      }
    }
  }
  return seats;
}

const all: SeatRec[] = [];
const winners: number[] = [];
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  const seats = await playOne(1000 + g);
  all.push(...seats);
  winners.push(Math.max(...seats.map((s) => s.vp)));
  if ((g + 1) % 3 === 0) console.log(`[${g + 1}/${GAMES}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
const N = all.length;
const avg = (f: (s: SeatRec) => number) => all.reduce((a, s) => a + f(s), 0) / N;
const vps = all.map((s) => s.vp).sort((a, b) => a - b);
const fmt = (x: number) => x.toFixed(1);

console.log(`\n== ${SPEC} 4p 自对局 ×${GAMES}（${N} 座位）终局差距审计 ==`);
console.log(`终局 VP: 均值 ${fmt(avg((s) => s.vp))} | 中位 ${vps[N >> 1]} | min ${vps[0]} | max ${vps[N - 1]}`);
console.log(`冠军线（每局最高分）: 均值 ${fmt(winners.reduce((a, b) => a + b, 0) / winners.length)} | max ${Math.max(...winners)} | ≥150 局数 ${winners.filter((v) => v >= 150).length}/${GAMES}`);

console.log(`\n-- VP 三分解（均值/座） --`);
console.log(`banked(对局中入账) ${fmt(avg((s) => s.banked))} | flipVP(终局翻面) ${fmt(avg((s) => s.flipVP))} | linkVP(路分) ${fmt(avg((s) => s.linkVP))}（Link 条数 ${fmt(avg((s) => s.linkCount))}）`);

console.log(`\n-- 未翻面浪费（均值/座） --`);
console.log(`${fmt(avg((s) => s.unflipped.n))} 块 | 面值 VP ${fmt(avg((s) => s.unflipped.vp))} | 造价 £${fmt(avg((s) => s.unflipped.cost))} | 余方块 ${fmt(avg((s) => s.unflipped.cubes))} | 余酒桶 ${fmt(avg((s) => s.unflipped.barrels))}`);
const byInd = new Map<IndustryType, { n: number; vp: number }>();
for (const s of all)
  for (const [k, e] of Object.entries(s.unflippedByInd) as [IndustryType, { n: number; vp: number }][]) {
    const a = byInd.get(k) ?? { n: 0, vp: 0 };
    a.n += e.n;
    a.vp += e.vp;
    byInd.set(k, a);
  }
for (const [k, e] of [...byInd.entries()].sort((a, b) => b[1].vp - a[1].vp))
  console.log(`  ${k.padEnd(12)} ${(e.n / N).toFixed(2)} 块/座 | 面值 ${(e.vp / N).toFixed(1)} VP/座`);

console.log(`\n-- 没拍下去（均值/座） --`);
console.log(`终局手牌 ${fmt(avg((s) => s.hand))} 张`);
const placed = new Map<IndustryType, number>();
for (const s of all)
  for (const [k, v] of Object.entries(s.placedByInd) as [IndustryType, number][])
    placed.set(k, (placed.get(k) ?? 0) + v);
for (const [k, total] of [...catalog.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(12)} 终局在场 ${(placed.get(k) ?? 0) / N}/${total} 块/座（差 = 研发移除 + 没建）`);

console.log(`\n-- 钱/收入（不折分，浪费信号） --`);
console.log(`终局余钱 £${fmt(avg((s) => s.money))} | 收入等级 ${fmt(avg((s) => s.income))}`);

console.log(`\n-- 到 150 的差距（均值/座） --`);
const gap = 150 - avg((s) => s.vp);
console.log(`差 ${fmt(gap)} VP：未翻面可回收 ~${fmt(avg((s) => s.unflipped.vp) * 0.8)}（按 80% 可翻估）+ Link 强度（现 linkVP 占 ${(avg((s) => s.linkVP) / avg((s) => s.vp) * 100).toFixed(0)}%）+ 手牌兑现 ~${fmt(avg((s) => s.hand) * 3)}（按 3VP/建 估）≈ 可解释 ${fmt(avg((s) => s.unflipped.vp) * 0.8 + avg((s) => s.hand) * 3)}，其余需靠建造结构升级（更高 VP 板块/L3+ 占比）`);
