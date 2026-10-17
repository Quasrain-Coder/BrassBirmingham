/**
 * 顺位控制·影子探测器（E31，2026-10-17，B站视频消化后开工）
 *
 * meta 核心发现：套路的胜负手之一是"本回合花费→下回合顺位"的主动控制
 * （棉路 £15 沉底 / 绵绵 £24 沉底换第三轮收入+5 / 6-8 沉底→7-8 抢先手→8-8 第一个卖
 * / 路开科厂卡顺位防对手沉底）。本探测只观测不改行为，回答：
 *   Q1 顺位变化率：现行冠军线的轮间顺位是否粘滞（不控=没有 tempo 概念=上行空间）？
 *   Q2 末轮先手效应：一时代最后一轮第一个动的人，该轮卖出数/翻面率/胜率是否显著更高？
 *   Q3 沉底模式：era1 后段（round 6-7）花得最多（下轮最后动）的人，下轮行动价值是否更高？
 *      以及"交替节奏"（高花费轮接低花费轮）与胜率的关系。
 *   Q4 每轮先手的胜率增益随轮次的曲线（哪些轮先手最值钱）。
 *
 * 用法: npx vite-node bench/tempo-probe.ts [spec=builtin:jsb-v20261010] [局数=40] [种子起点=2100]
 */
import {
  applyAction,
  enumerateActions,
  incomeLevelAt,
  newGame,
  type GameState,
  type PlayerIndex,
} from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const SPEC = process.argv[2] ?? 'builtin:jsb-v20261010';
const GAMES = Number(process.argv[3] ?? 40);
const SEED0 = Number(process.argv[4] ?? 2100);
const OUT = process.env.E31_OUT ?? ''; // 每局 JSONL 落盘路径
const MERGE = process.argv[2] === 'merge';

interface RoundSnap {
  era: number;
  round: number;
  /** 本轮执行顺序（turnOrder 拷贝）。 */
  order: PlayerIndex[];
  /** 每人本轮花费（行动结束时快照）。 */
  spent: number[];
  /** 每人本轮动作类型序列。 */
  acts: string[][];
}

interface PlayerGame {
  seat: PlayerIndex;
  vp: number;
  won: boolean;
  income: number;
  /** 每轮该玩家的行动序位（0=第一个动）。 */
  posByRound: number[];
  /** 每轮花费。 */
  spendByRound: number[];
  /** era1 各轮 sell 数。 */
  sellsByRoundEra1: number[];
  flipsEra1: number;
  buildsEra1: number;
}

async function playOne(seed: number): Promise<{ snaps: RoundSnap[]; players: PlayerGame[] }> {
  const agents = Array.from({ length: 4 }, (_, seat) => createAgent(SPEC, { seat }));
  let state: GameState = newGame(4, seed);
  const snaps: RoundSnap[] = [];
  // 本轮进行中的累计
  let cur: RoundSnap | null = null;
  let prevKey = '';
  // era1 翻面追踪：对比时代切换瞬间
  let era1FlipSnapshot: number[] | null = null;

  const eraNum = () => (state.era === 'canal' ? 1 : 2);
  const flipCount = (s: GameState) => {
    const counts = [0, 0, 0, 0];
    for (const slots of Object.values(s.board.slots))
      for (const t of slots) if (t && t.flipped) counts[t.player]!++;
    return counts;
  };

  let steps = 0;
  while (state.phase !== 'game-over') {
    const key = `${eraNum()}:${state.round}`;
    if (key !== prevKey) {
      if (cur) snaps.push(cur);
      cur = { era: eraNum(), round: state.round, order: [...state.turnOrder], spent: [0, 0, 0, 0], acts: [[], [], [], []] };
      prevKey = key;
    }
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    const moneyBefore = state.players[player]!.money;
    const { action } = await agents[player]!.decide(state, player, legal);
    state = applyAction(state, action);
    const moneyAfter = state.players[player]!.money;
    // 净花费（贷款是负花费）
    cur!.spent[player]! += Math.max(0, moneyBefore - moneyAfter);
    cur!.acts[player]!.push(action.type);
    if (eraNum() === 2 && era1FlipSnapshot === null) era1FlipSnapshot = flipCount(state);
    if (++steps > 100_000) throw new Error('runaway');
  }
  if (cur) snaps.push(cur);

  const winner = state.players.reduce((a, p) => (p.vp > a.vp ? p : a));
  const era1Rounds = snaps.filter((s) => s.era === 1);
  const players: PlayerGame[] = state.players.map((p, seat) => {
    const posByRound: number[] = [];
    const spendByRound: number[] = [];
    const sellsByRoundEra1: number[] = [];
    for (const s of snaps) {
      posByRound.push(s.order.indexOf(seat as PlayerIndex));
      spendByRound.push(s.spent[seat] ?? 0);
      if (s.era === 1) sellsByRoundEra1.push(s.acts[seat]!.filter((a) => a === 'sell').length);
    }
    return {
      seat: seat as PlayerIndex,
      vp: p.vp,
      won: p === winner,
      income: incomeLevelAt(p.incomeSpace),
      posByRound,
      spendByRound,
      sellsByRoundEra1,
      flipsEra1: era1FlipSnapshot?.[seat] ?? 0,
      buildsEra1: era1Rounds.reduce((n, s) => n + s.acts[seat]!.filter((a) => a === 'build').length, 0),
    };
  });
  return { snaps, players };
}

async function main() {
if (MERGE) {
  const fs = await import('node:fs');
  const files = process.argv.slice(3);
  const games = files.flatMap((f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  aggregate(games);
  return;
}
const games: Awaited<ReturnType<typeof playOne>>[] = [];
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  const one = await playOne(SEED0 + g);
  games.push(one);
  if (OUT) (await import('node:fs')).appendFileSync(OUT, JSON.stringify(one) + '\n');
  if ((g + 1) % 5 === 0) console.log(`[${g + 1}/${GAMES}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
aggregate(games);
}

function aggregate(games: Awaited<ReturnType<typeof playOne>>[]) {

// ---------- 聚合 ----------
console.log(`\n== 顺位探测 ×${games.length} 局（${SPEC} 自对弈，seeds ${SEED0}+）==`);

// Q1 顺位粘滞率：相邻两轮序位不变的玩家占比
let sticky = 0, trans = 0;
for (const g of games) for (const p of g.players) {
  for (let r = 1; r < p.posByRound.length; r++) {
    trans++;
    if (p.posByRound[r] === p.posByRound[r - 1]) sticky++;
  }
}
console.log(`Q1 顺位粘滞率: ${(100 * sticky / trans).toFixed(1)}%（轮间序位不变占比；高=没有主动控顺位）`);

// Q4 每轮先手/末手的胜率（按轮次）
const maxR = Math.max(...games.flatMap((g) => g.snaps.map((s) => s.round + (s.era === 2 ? 100 : 0))));
console.log('Q4 各轮先手/末手胜率:');
for (let era = 1; era <= 2; era++) {
  const rounds = Math.max(...games.flatMap((g) => g.snaps.filter((s) => s.era === era).map((s) => s.round)));
  for (let r = 1; r <= rounds; r++) {
    let firstWin = 0, firstN = 0, lastWin = 0, lastN = 0;
    for (const g of games) {
      const snap = g.snaps.find((s) => s.era === era && s.round === r);
      if (!snap) continue;
      const first = snap.order[0]!, last = snap.order[3]!;
      const fp = g.players.find((p) => p.seat === first)!;
      const lp = g.players.find((p) => p.seat === last)!;
      firstN++; lastN++;
      if (fp.won) firstWin++;
      if (lp.won) lastWin++;
    }
    if (firstN >= 8) {
      console.log(
        `  era${era} r${String(r).padStart(2)}: 先手胜率 ${(100 * firstWin / firstN).toFixed(0)}% (n=${firstN}) | 末手胜率 ${(100 * lastWin / lastN).toFixed(0)}%`,
      );
    }
  }
}
void maxR;

// Q2 era1 末轮先手效应
let fSell = 0, fN = 0, oSell = 0, oN = 0, fFlip = 0, oFlip = 0, fWin = 0, oWin = 0;
for (const g of games) {
  const e1 = g.snaps.filter((s) => s.era === 1);
  if (!e1.length) continue;
  const lastSnap = e1[e1.length - 1]!;
  const firstSeat = lastSnap.order[0]!;
  for (const p of g.players) {
    const sells = p.sellsByRoundEra1[e1.length - 1] ?? 0;
    if (p.seat === firstSeat) { fSell += sells; fFlip += p.flipsEra1; if (p.won) fWin++; fN++; }
    else { oSell += sells; oFlip += p.flipsEra1; if (p.won) oWin++; oN++; }
  }
}
console.log(`Q2 era1末轮: 先手者 当轮卖出 ${(fSell / fN).toFixed(2)}次 | era1翻面 ${(fFlip / fN).toFixed(1)} | 胜率 ${(100 * fWin / fN).toFixed(0)}%`);
console.log(`         其他人 当轮卖出 ${(oSell / oN).toFixed(2)}次 | era1翻面 ${(oFlip / oN).toFixed(1)} | 胜率 ${(100 * oWin / oN).toFixed(0)}%`);

// Q3 交替节奏：era1 round≥5 中"花费名次相邻轮摆动幅度"（0=不动，3=最大摆动）与胜率
let swingWin = 0, swingN = 0, calmWin = 0, calmN = 0;
for (const g of games) {
  const e1 = g.snaps.filter((s) => s.era === 1);
  for (const p of g.players) {
    let swingSum = 0, cnt = 0;
    for (let r = 5; r < e1.length; r++) {
      const rankNow = e1[r]!.spent.slice().sort((a, b) => b - a).indexOf(p.spendByRound[r]!);
      const rankPrev = e1[r - 1]!.spent.slice().sort((a, b) => b - a).indexOf(p.spendByRound[r - 1]!);
      swingSum += Math.abs(rankNow - rankPrev); cnt++;
    }
    if (!cnt) continue;
    const avg = swingSum / cnt;
    if (avg >= 1.5) { swingN++; if (p.won) swingWin++; }
    else { calmN++; if (p.won) calmWin++; }
  }
}
console.log(`Q3 era1后段交替节奏（摆动≥1.5名次/轮）: 胜率 ${(100 * swingWin / swingN).toFixed(0)}% (n=${swingN}) | 平稳者 ${(100 * calmWin / calmN).toFixed(0)}% (n=${calmN})`);
console.log('   （现行 AI 无 tempo 概念：若两组胜率无差且粘滞率高 → 有上行空间待开发）');
}

await main();
