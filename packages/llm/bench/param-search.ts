/**
 * 参数空间随机搜索（1010 track-1）：在 0911 平坦高原上找组合最优点。
 * 每个配置 = 随机抽 2-4 个键扰动（便于归因），适应度 = 12 局 4p 自对局
 * 人均 VP（种子 0-11 固定，跨配置配对）。K 个 subprocess 并发评估，
 * 每个结果即报当前排行榜。跑完打印 Top5 配置（供 30 局复核 + h2h 终验）。
 * 用法: npx vite-node bench/param-search.ts [评估数=24] [并发=3] [局数=12]
 */
import { spawn } from 'node:child_process';

const ROUNDS = Number(process.argv[2] ?? 24);
const CONC = Number(process.argv[3] ?? 3);
const GAMES = Number(process.argv[4] ?? 12);

type Sampler = () => number;
/** 键 → 取值采样器（未抽中的键保持 0911 默认）。 */
const SPACE: Record<string, Sampler> = {
  'flip.coalDemandRail': () => 0.5 + Math.random() * 0.45,
  'build.railCoalLatePenalty': () => Math.random() * 3,
  'build.railHighLevelSellableBonus': () => Math.random() * 3,
  'build.railBrewerySellSupportBonus': () => Math.random() * 2,
  'sell.urgencyBonus': () => 2 + Math.random() * 3,
  'sell.batchBonus': () => 1 + Math.random() * 1.5,
  'network.unflippedIconCoefficient': () => 0.4 + Math.random() * 0.5,
  'network.lowValueFloor': () => 2 + Math.random() * 2,
  'network.lowValuePenalty': () => 0.4 + Math.random() * 0.8,
  'ismcts.topK': () => [4, 6, 8][Math.floor(Math.random() * 3)]!,
  'ismcts.rolloutJunkLinkFloor': () => 2 + Math.random() * 2,
};
const KEYS = Object.keys(SPACE);

function sampleConfig(): Record<string, Record<string, number>> {
  const nKeys = 2 + Math.floor(Math.random() * 3); // 2-4 个键
  const picked = [...KEYS].sort(() => Math.random() - 0.5).slice(0, nKeys);
  const cfg: Record<string, Record<string, number>> = {};
  for (const path of picked) {
    const [sect, key] = path.split('.') as [string, string];
    (cfg[sect] ??= {})[key] = Number(SPACE[path]!().toFixed(3));
  }
  return cfg;
}

function runEval(cfg: Record<string, Record<string, number>>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['vite-node', 'bench/benchmark.ts', String(GAMES), '4'], {
      cwd: process.cwd(),
      env: { ...process.env, BENCH_SPEC: 'builtin:jsb-v20260911', BRASS_TUNE11: JSON.stringify(cfg) },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`exit ${code}`));
      const m = out.match(/4p × \d+: 人均 ([\d.]+)/);
      if (!m) return reject(new Error(`no result in output: ${out.slice(-200)}`));
      resolve(Number(m[1]));
    });
  });
}

interface Rec {
  cfg: Record<string, Record<string, number>>;
  vp: number;
}
const results: Rec[] = [];
function leaderboard(): string {
  const top = [...results].sort((a, b) => b.vp - a.vp).slice(0, 5);
  return top.map((r, i) => `  #${i + 1} ${r.vp.toFixed(1)}  ${JSON.stringify(r.cfg)}`).join('\n');
}

let running = 0;
let launched = 0;
await new Promise<void>((done) => {
  const pump = (): void => {
    while (running < CONC && launched < ROUNDS) {
      const cfg = sampleConfig();
      launched += 1;
      running += 1;
      const tag = launched;
      runEval(cfg)
        .then((vp) => {
          results.push({ cfg, vp });
          console.log(`[${tag}/${ROUNDS}] ${vp.toFixed(1)}  ${JSON.stringify(cfg)}\n排行榜:\n${leaderboard()}\n`);
        })
        .catch((e) => console.log(`[${tag}/${ROUNDS}] ERROR ${String(e).slice(0, 120)}`))
        .finally(() => {
          running -= 1;
          pump();
          if (running === 0 && launched >= ROUNDS) done();
        });
    }
  };
  pump();
});
console.log(`\n===== 最终 Top5（${results.length} 个有效评估）=====\n${leaderboard()}`);
