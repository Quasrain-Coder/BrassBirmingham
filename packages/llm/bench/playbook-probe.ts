/**
 * 打法选择层·影子探测器（E26 前置验证）：开局按手牌/座位分类到 meta 套路，
 * 全程只观测不改行为。回答三个问题：
 * 1. 我们 0903 的开局手牌分布能否区分开套路（检测器有分辨率）？
 * 2. 各套路选择下的终局 VP / 贷款次数 / 余钱差异（按需选择有信号）？
 * 3. 检测套路 vs 实际打法（建造结构）的错位率（错位=纯上行空间）？
 *
 * 用法: npx vite-node bench/playbook-probe.ts [spec=builtin:jsb-v20260903] [局数=12] [种子起点=3000]
 */
import {
  applyAction,
  enumerateActions,
  incomeLevelAt,
  newGame,
  type Card,
  type GameState,
  type IndustryType,
  type PlayerIndex,
} from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const SPEC = process.argv[2] ?? 'builtin:jsb-v20260903';
const GAMES = Number(process.argv[3] ?? 12);
const SEED0 = Number(process.argv[4] ?? 3000);

type Playbook = 'iron-beer' | 'cotton3' | 'road-pottery' | 'zero-loan-iron' | 'no-beer-cotton' | 'generic';

/** 手牌对某产业的支持度：产业卡 +1，对应位置卡 +1（粗粒度：位置卡按名字含产业热点城市近似），百搭 +0.5。 */
function industrySupport(hand: Card[], ind: IndustryType): number {
  let s = 0;
  for (const c of hand) {
    if (c.kind === 'industry' && c.industries.includes(ind)) s += 1;
    else if (c.kind === 'location' && (LOC_HINT[ind] ?? []).some((loc) => c.location.includes(loc))) s += 1;
    else if (c.kind === 'wild-industry' || c.kind === 'wild-location') s += 0.5;
  }
  return s;
}

/** 位置卡热点城市近似（按产业地标城市粗匹配，影子探测够用）。 */
const LOC_HINT: Partial<Record<IndustryType, string[]>> = {
  cotton: ['manchester', 'oldham', 'rochdale', 'blackburn', 'bury', 'stockport'],
  manufacturer: ['birmingham', 'coventry', 'redditch', 'kidderminster', 'nuneaton', 'tamworth'],
  iron: ['birmingham', 'coalbrookdale', 'dudley', 'wolverhampton'],
  coal: ['coalbrookdale', 'cannock', 'walsall', 'burton'],
  pottery: ['stoke', 'stone', 'leek', 'belper'],
  brewery: ['coalbrookdale', 'wolverhampton', 'burton', 'warrington'],
};

/** 开局套路适配分（meta 开局表的手牌/座位条件粗翻译）。 */
function fitPlaybook(hand: Card[], seat: PlayerIndex): { pb: Playbook; fit: number } {
  const sup = (i: IndustryType) => industrySupport(hand, i);
  const scores: [Playbook, number][] = [
    // 三棉：棉支持强（传统三棉"市场手牌要求不高"但要有棉卡）
    ['cotton3', sup('cotton') * 2.2 + (sup('cotton') >= 3 ? 1.5 : 0)],
    // 路陶：陶支持（先手后手皆有条目，陶 L1 £17 贵——赌性线）
    ['road-pottery', sup('pottery') * 2.4],
    // 0贷铁箱：铁煤双支持（有煤补煤有铁补铁）
    ['zero-loan-iron', (sup('iron') + sup('coal')) * 1.1 + Math.min(sup('iron'), sup('coal'))],
    // 无酒棉：棉支持强但酒支持弱
    ['no-beer-cotton', sup('cotton') * 2.0 - sup('brewery') * 0.8],
    // 铁酒（标准基本盘）
    ['iron-beer', sup('iron') + sup('brewery') * 1.2 + 1.0],
  ];
  // 四号位偏好转：路开科厂信号（meta 条16）→ 0贷铁箱加权
  if (seat === 3) {
    for (const e of scores) if (e[0] === 'zero-loan-iron') e[1] += 0.6;
  }
  scores.sort((a, b) => b[1] - a[1]);
  const top = scores[0]!;
  // 分辨率阈值：顶部适配分太低视为 generic（手牌无明显套路指向）
  return top[1] < 2.5 ? { pb: 'generic', fit: top[1] } : { pb: top[0], fit: top[1] };
}

interface SeatStat {
  pb: Playbook;
  fit: number;
  seat: PlayerIndex;
  vp: number;
  income: number;
  money: number;
  loans: number;
  builds: Partial<Record<IndustryType, number>>;
  links: number;
}

async function playOne(seed: number): Promise<SeatStat[]> {
  const agents = Array.from({ length: 4 }, (_, seat) => createAgent(SPEC, { seat }));
  let state: GameState = newGame(4, seed);
  // 开局分类：turnOrder 位次即座位顺位
  const stats: SeatStat[] = state.players.map((p, i) => {
    const { pb, fit } = fitPlaybook(p.hand, i);
    return { pb, fit, seat: i, vp: 0, income: 0, money: 0, loans: 0, builds: {}, links: 0 };
  });
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    const { action } = await agents[player]!.decide(state, player, legal);
    const s = stats[player]!;
    if (action.type === 'loan') s.loans += 1;
    if (action.type === 'build') s.builds[action.industry] = (s.builds[action.industry] ?? 0) + 1;
    if (action.type === 'network') s.links += action.links.length;
    state = applyAction(state, action);
    if (++steps > 100_000) throw new Error('runaway');
  }
  state.players.forEach((p, i) => {
    const s = stats[i]!;
    s.vp = p.vp;
    s.income = incomeLevelAt(p.incomeSpace);
    s.money = p.money;
  });
  return stats;
}

const all: SeatStat[] = [];
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  all.push(...(await playOne(SEED0 + g)));
  if ((g + 1) % 4 === 0) console.log(`[${g + 1}/${GAMES}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

console.log(`\n== ${SPEC} ×${GAMES}（${all.length} 座）开局套路影子探测 ==`);
const byPb = new Map<Playbook, SeatStat[]>();
for (const s of all) {
  const arr = byPb.get(s.pb) ?? [];
  arr.push(s);
  byPb.set(s.pb, arr);
}
const avg = <T>(arr: T[], f: (t: T) => number) => (arr.length ? arr.reduce((a, t) => a + f(t), 0) / arr.length : 0);
for (const [pb, arr] of [...byPb.entries()].sort((a, b) => avg(b[1], (s) => s.vp) - avg(a[1], (s) => s.vp))) {
  console.log(
    `${pb.padEnd(16)} n=${String(arr.length).padStart(2)} | VP ${avg(arr, (s) => s.vp).toFixed(1)} | 收入 ${avg(arr, (s) => s.income).toFixed(1)} | 余钱 £${avg(arr, (s) => s.money).toFixed(0)} | 贷款 ${avg(arr, (s) => s.loans).toFixed(1)} | Link ${avg(arr, (s) => s.links).toFixed(1)}`,
  );
  const top = Object.entries(
    arr.reduce((m, s) => {
      for (const [k, v] of Object.entries(s.builds)) m[k as IndustryType] = (m[k as IndustryType] ?? 0) + v;
      return m;
    }, {} as Partial<Record<IndustryType, number>>),
  )
    .map(([k, v]) => [k, v / arr.length] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join(' / ');
  console.log(`    实际建造 top3: ${top}`);
}
