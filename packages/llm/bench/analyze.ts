/**
 * bench 失败分析：读 decisions.jsonl，快速定位 LLM 弱在哪一类。
 *
 *   ../../node_modules/.bin/vite-node bench/analyze.ts bench/out/<runId> [--seat llm]
 *
 * 三类失败口径（对应 plan Phase 2）：
 * - chosenRank 分布：LLM 所选在 scoreAction 降序中的名次。恒 0 → LLM 无增量，
 *   棋力上限 = 预筛（去调 HEURISTIC_WEIGHTS）；常偏离 0 且输 → 候选内选错
 *   （改 SYSTEM_PROMPT 策略段）。
 * - 行动类型频率：按描述前缀归类（建/铺/卖/研发/贷款/搜寻/跳过），对比
 *   LLM 与启发式的行动结构差异（如 LLM 从不贷款、过度研发）。
 * - degraded 率与输局分布：输局中 LLM 的早期（运河前 3 轮）选择抽样。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface DecisionRow {
  seq: number;
  seat: number;
  era: string;
  round: number;
  legalCount: number;
  chosenRank: number;
  heuristicTop: string;
  chosen: string;
  reason: string;
  degraded: boolean;
  seed: number;
  mirrored: boolean;
  usage: { input: number; output: number };
}

interface GameRow {
  seed: number;
  mirrored: boolean;
  seatLabels: string[];
  vps: number[];
  winner: number | null;
  steps: number;
}

/** 行动描述 → 类型（与 summarize.ts describeAction 的前缀对齐）。 */
function actionKind(desc: string): string {
  if (desc.startsWith('在')) return 'build';
  if (desc.startsWith('铺')) return 'network';
  if (desc.startsWith('卖出')) return 'sell';
  if (desc.startsWith('研发')) return 'develop';
  if (desc.startsWith('贷款')) return 'loan';
  if (desc.startsWith('搜寻')) return 'scout';
  if (desc.startsWith('跳过')) return 'pass';
  return 'unknown';
}

function hist(nums: number[]): string {
  const buckets = new Map<string, number>();
  for (const n of nums) {
    const b = n === 0 ? '0' : n <= 2 ? '1-2' : n <= 5 ? '3-5' : n <= 10 ? '6-10' : '11+';
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const total = nums.length;
  return ['0', '1-2', '3-5', '6-10', '11+']
    .filter((b) => buckets.has(b))
    .map((b) => `${b}:${((buckets.get(b)! / total) * 100).toFixed(0)}%`)
    .join(' ');
}

function main(): void {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('用法: vite-node bench/analyze.ts <outDir>');
    process.exit(1);
  }
  const decisions = readFileSync(join(dir, 'decisions.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as DecisionRow);
  const games = readFileSync(join(dir, 'games.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as GameRow);

  // 输局集合（按 seed+mirrored+seat 定位决策属于哪局哪位）
  const gameKey = (g: GameRow) => `${g.seed}:${g.mirrored}`;
  const lostSeats = new Map<string, Set<number>>();
  for (const g of games) {
    const lost = new Set<number>();
    g.seatLabels.forEach((label, seat) => {
      const lost_ =
        g.winner === null ? false : g.winner !== seat;
      if (lost_) lost.add(seat);
    });
    lostSeats.set(gameKey(g), lost);
  }

  // 按标签分组（seatLabels 从 games 取；decisions 只带 seat——经 seed+mirrored 关联）
  const labelOf = new Map<string, string[]>();
  for (const g of games) labelOf.set(gameKey(g), g.seatLabels);

  const byLabel = new Map<string, DecisionRow[]>();
  for (const d of decisions) {
    const labels = labelOf.get(`${d.seed}:${d.mirrored}`);
    const label = labels?.[d.seat] ?? `seat${d.seat}`;
    const list = byLabel.get(label) ?? [];
    list.push(d);
    byLabel.set(label, list);
  }

  for (const [label, ds] of byLabel) {
    console.log(`\n===== ${label}（${ds.length} 次决策）=====`);
    console.log(`chosenRank 分布: ${hist(ds.map((d) => d.chosenRank))}`);
    const kinds = new Map<string, number>();
    for (const d of ds) {
      const k = actionKind(d.chosen);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    console.log(
      `行动类型: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${((n / ds.length) * 100).toFixed(0)}%`).join(' ')}`,
    );
    const degraded = ds.filter((d) => d.degraded).length;
    console.log(`degraded: ${((degraded / ds.length) * 100).toFixed(1)}%`);
    // 分时代 chosenRank
    for (const era of ['canal', 'rail']) {
      const sub = ds.filter((d) => d.era === era);
      if (sub.length > 0) {
        console.log(`  ${era}: rank ${hist(sub.map((d) => d.chosenRank))}`);
      }
    }
    // 输局早期决策抽样（运河前 3 轮）
    const earlyLost = ds.filter(
      (d) =>
        d.era === 'canal' &&
        d.round <= 3 &&
        lostSeats.get(`${d.seed}:${d.mirrored}`)?.has(d.seat),
    );
    if (earlyLost.length > 0) {
      console.log(`输局运河前3轮决策抽样（前 8 条）:`);
      for (const d of earlyLost.slice(0, 8)) {
        console.log(
          `  seed${d.seed}${d.mirrored ? '(镜)' : ''} 轮${d.round} rank${d.chosenRank} ` +
            `选[${d.chosen.slice(0, 50)}] 最优[${d.heuristicTop.slice(0, 50)}]`,
        );
      }
    }
  }
}

main();
