/**
 * GLM-5.3-Flash（bigmodel Anthropic 兼容网关）vs jsb-v20260903 ×3 的 4p 对抗跑批。
 * llm-vs-plugin.ts 的变体：对手换成当前默认 0903，LLM 座位按局轮换，每局落盘
 * games.jsonl / decisions.jsonl（复用 TraceWriter）并另写 digest.md（轮末轨迹 +
 * 各席画像 + 完整决策日志），供 sub agent 逐局复盘。
 *
 * 用法（经 esbuild 打包后跑，省 vite-node 常驻内存）：
 *   node glm-vs0903.runner.mjs --seed-base S --games N --out D
 * 环境变量：
 *   ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN  bigmodel 网关 + key
 *   BRASS_AI_MODEL=glm-5.3-flash               LLM 席位模型
 *   BRASS_AI_TIMEOUT_MS=30000                  单请求超时
 *   BRASS_GLM_SLOTS=8                          跨进程全局 LLM 并发槽（目录锁）
 *   BRASS_GLM_SLOTS_DIR=/tmp/brass-glm-slots   槽位目录
 */
import { applyAction, newGame } from '@brass/engine';
import { mkdirSync, rmdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnthropicClient } from '../src/client.js';
import type { ClaudeClient, DecideRequest, DecideResponse } from '../src/client.js';
import { LLMAgent } from '../src/llm-agent.js';
import { createAgent } from '../src/agents/registry.js';
import { describeAction } from '../src/summarize.js';
import { driveGame } from './drive-game.js';
import { STRATEGY_VARIANTS } from './variants.js';
import { TraceWriter, gameRecord } from './trace.js';

const BOT_SPEC = 'builtin:jsb-v20260903';
const LLM_LABEL = 'llm:glm-5.3-flash';
const BOT_LABEL = 'jsb-v20260903';

function parseArgs(argv: string[]): { seedBase: number; games: number; outDir: string; llmVariant?: string } {
  const opts: { seedBase: number; games: number; outDir: string; llmVariant?: string } = {
    seedBase: 1, games: 1, outDir: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const take = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${argv[i - 1]} 缺参数值`);
      return v;
    };
    switch (argv[i]) {
      case '--seed-base': opts.seedBase = Number(take()); break;
      case '--games': opts.games = Number(take()); break;
      case '--out': opts.outDir = take(); break;
      case '--llm-variant': opts.llmVariant = take(); break;
      default: throw new Error(`未知参数: ${argv[i]}`);
    }
  }
  if (!opts.outDir) throw new Error('必须给 --out');
  if (!Number.isInteger(opts.games) || opts.games < 1) throw new Error('--games 须为正整数');
  if (opts.llmVariant !== undefined && !(opts.llmVariant in STRATEGY_VARIANTS)) {
    throw new Error(`未知 --llm-variant: ${opts.llmVariant}（可用: ${Object.keys(STRATEGY_VARIANTS).join(', ')}）`);
  }
  return opts;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- 跨进程全局并发槽（目录锁）：把所有 agent 进程的 LLM 在飞请求数压在 SLOTS 内 ----
const SLOTS = Math.max(1, Number(process.env['BRASS_GLM_SLOTS'] ?? 8));
const SLOTS_DIR = process.env['BRASS_GLM_SLOTS_DIR'] ?? '/tmp/brass-glm-slots';
const STALE_MS = 10 * 60_000; // 槽位目录超龄视为残留（进程崩溃），直接清掉

async function acquireSlot(): Promise<() => void> {
  mkdirSync(SLOTS_DIR, { recursive: true });
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const order = [...Array(SLOTS).keys()].sort(() => Math.random() - 0.5);
    for (const k of order) {
      const p = join(SLOTS_DIR, `slot-${k}`);
      try {
        mkdirSync(p);
        return () => {
          try { rmdirSync(p); } catch { /* 已被超龄清理抢走 */ }
        };
      } catch {
        try {
          if (Date.now() - statSync(p).mtimeMs > STALE_MS) {
            rmSync(p, { recursive: true, force: true });
          }
        } catch { /* 他人已清 */ }
      }
    }
    if (Date.now() > deadline) throw new Error('acquireSlot: 等待槽位超时（10min）');
    await sleep(200 + Math.random() * 400);
  }
}

/**
 * 包一层：maxTokens 抬到 ≥1024（GLM 网关有的开 thinking，512 易截断成
 * 无 tool_use → 降级）+ 429/限流指数退避重试（网关 1302 是限流）。
 * 槽位在「含重试的整次 decide」期间持有，避免重试期放大并发。
 */
class SlotRetryClient implements ClaudeClient {
  private readonly inner: ClaudeClient = new AnthropicClient({});

  async decide(req: DecideRequest): Promise<DecideResponse> {
    const release = await acquireSlot();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.inner.decide({
            ...req,
            maxTokens: Math.max(req.maxTokens, 1024),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < 6 && /rate.?limit|1302|429|overloaded|529/i.test(msg)) {
            const wait = 2 ** attempt * 1000 * (0.8 + Math.random() * 0.4);
            console.log(`  [slot] 限流退避 ${Math.round(wait)}ms（第 ${attempt + 1} 次）`);
            await sleep(wait);
            continue;
          }
          throw err;
        }
      }
    } finally {
      release();
    }
  }
}

// ---- digest.md：sub agent 复盘的输入 ----

/** 与 analyze.ts actionKind 对齐（describeAction 前缀）。 */
function actionKind(desc: string): string {
  if (desc.startsWith('在')) return '建';
  if (desc.startsWith('铺')) return '铺';
  if (desc.startsWith('卖出')) return '卖';
  if (desc.startsWith('研发')) return '研发';
  if (desc.startsWith('贷款')) return '贷';
  if (desc.startsWith('搜寻')) return '侦';
  if (desc.startsWith('跳过')) return '跳';
  return '?';
}

function rankHist(nums: number[]): string {
  const b = { '0': 0, '1-2': 0, '3-5': 0, '6-10': 0, '11+': 0 } as Record<string, number>;
  for (const n of nums) {
    const k = n === 0 ? '0' : n <= 2 ? '1-2' : n <= 5 ? '3-5' : n <= 10 ? '6-10' : '11+';
    b[k] = (b[k] ?? 0) + 1;
  }
  const total = Math.max(1, nums.length);
  return Object.entries(b).map(([k, v]) => `${k}:${((v / total) * 100).toFixed(0)}%`).join(' ');
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

async function main(): Promise<void> {
  const { seedBase, games, outDir, llmVariant } = parseArgs(process.argv.slice(2));
  const client = new SlotRetryClient();
  mkdirSync(outDir, { recursive: true });

  for (let g = 0; g < games; g++) {
    const seed = seedBase + g;
    const llmSeat = g % 4;
    const labels = [0, 1, 2, 3].map((s) =>
      (s === llmSeat ? `${LLM_LABEL}${llmVariant ? `@${llmVariant}` : ''}` : BOT_LABEL),
    );
    const gameDir = join(outDir, `g${g}-seed${seed}`);
    const writer = new TraceWriter(gameDir);

    const agents = [0, 1, 2, 3].map((seat) => {
      if (seat !== llmSeat) return createAgent(BOT_SPEC, { seat });
      const extra = llmVariant !== undefined ? (STRATEGY_VARIANTS[llmVariant] ?? undefined) : undefined;
      return new LLMAgent(client, 'normal', undefined, extra !== undefined ? { systemExtra: extra } : undefined);
    });

    const t0 = Date.now();
    const game = await driveGame(4, seed, agents);
    const record = gameRecord(game, labels, false, Date.now() - t0);
    for (const d of game.decisions) {
      writer.decision({ ...d, seed, mirrored: false });
    }
    writer.game(record);

    const llmRows = game.decisions.filter((d) => d.seat === llmSeat);
    const llmDegraded = llmRows.filter((d) => d.degraded).length;
    const tokIn = llmRows.reduce((s, d) => s + d.usage.input, 0);
    const tokOut = llmRows.reduce((s, d) => s + d.usage.output, 0);

    // ---- 轮末轨迹：纯重放 action log 快照 ----
    let st = newGame(4, seed);
    const traj: string[] = [];
    let prevEra = st.era;
    let prevRound = st.round;
    const snap = (label: string): void => {
      traj.push(
        `| ${label} | ${st.players.map((p) => `${p.vp} / ${p.incomeSpace} / £${p.money}`).join(' | ')} |`,
      );
    };
    snap('开局');
    for (const a of game.log) {
      st = applyAction(st, a);
      if (st.era !== prevEra) {
        snap(`${prevEra === 'canal' ? '运河' : '铁路'}时代末`);
        prevEra = st.era;
        prevRound = st.round;
      } else if (st.round !== prevRound) {
        snap(`${prevEra === 'canal' ? '运河' : '铁路'} R${prevRound} 末`);
        prevRound = st.round;
      }
    }
    snap('终局');

    // ---- 各席画像 ----
    const loser = record.winner === null ? -1 : [0, 1, 2, 3]
      .reduce((w, s) => (record.vps[s]! < record.vps[w]! ? s : w), 0);
    const portraits = [0, 1, 2, 3].map((s) => {
      const rows = game.decisions.filter((d) => d.seat === s);
      const kinds = new Map<string, number>();
      for (const d of rows) kinds.set(actionKind(d.chosen), (kinds.get(actionKind(d.chosen)) ?? 0) + 1);
      return [
        `### P${s} ${labels[s]}${s === record.winner ? ' —— 冠军' : ''}${s === loser ? ' —— 垫底' : ''}`,
        `- 终局 VP ${record.vps[s]}｜决策 ${rows.length} 次｜degraded ${rows.filter((d) => d.degraded).length}`,
        `- 行动分布: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${((n / rows.length) * 100).toFixed(0)}%`).join(' ')}`,
        `- chosenRank 分布: ${rankHist(rows.map((d) => d.chosenRank))}`,
      ].join('\n');
    });

    // ---- 完整决策日志 ----
    const log = [
      '| seq | 席 | 时点 | 选择 | rank | 启发式最优 | 理由 |',
      '|---|---|---|---|---|---|---|',
      ...game.decisions.map(
        (d) =>
          `| ${d.seq} | P${d.seat} | ${d.era === 'canal' ? '运' : '铁'}R${d.round} | ${clip(d.chosen, 60)} | ${d.chosenRank} | ${clip(d.heuristicTop, 36)} | ${d.seat === llmSeat ? clip(d.reason, 120) : '—'} |`,
      ),
    ].join('\n');

    const digest = [
      `# 对局 digest — seed ${seed}（LLM=GLM-5.3-Flash 席位 P${llmSeat}，其余 3 席 jsb-v20260903）`,
      '',
      `结果: ${record.vps.map((v, i) => `P${i}(${labels[i]})=${v}`).join(' | ')}`,
      `胜者: ${record.winner === null ? '平局' : `P${record.winner}`}｜垫底: P${loser}｜总步数 ${record.steps}｜耗时 ${(record.durationMs / 1000).toFixed(0)}s`,
      `LLM 席位: 决策 ${llmRows.length} 次，degraded ${llmDegraded}，token in=${tokIn} out=${tokOut}`,
      '',
      '## 轮末轨迹（各席：VP / 收入等级 / 现金）',
      '| 时点 | P0 | P1 | P2 | P3 |',
      '|---|---|---|---|---|',
      ...traj,
      '',
      '## 各席画像',
      ...portraits.map((p) => `${p}\n`),
      '## 完整决策日志',
      log,
      '',
    ].join('\n');
    writeFileSync(join(gameDir, 'digest.md'), digest);

    console.log(
      `GAME DONE seed=${seed} llmSeat=P${llmSeat} vps=[${record.vps.join(',')}] ` +
        `winner=${record.winner ?? 'tie'} last=P${loser} llmVP=${record.vps[llmSeat]} ` +
        `llmDecisions=${llmRows.length} llmDegraded=${llmDegraded} tokIn=${tokIn} tokOut=${tokOut} ` +
        `elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s digest=${join(gameDir, 'digest.md')}`,
    );
  }
}

main().catch((e: unknown) => {
  console.error('[glm-vs0903] 失败', e);
  process.exit(1);
});
