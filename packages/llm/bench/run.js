/**
 * bench CLI：自对弈跑批 + 汇总。手动跑（烧 token，不进 CI）：
 *
 *   npm run bench -w @brass/llm -- \
 *     --agents llm:normal,heuristic --games 10 --seed-base 1 --mirror \
 *     --concurrency 4 --out bench/out/<runId>
 *
 * 参数：
 *   --agents spec     座位配置，逗号分隔：`llm:<easy|normal|hard>` 或
 *                     `heuristic`。人数 = spec 项数（本迭代全程 2p）。
 *   --games N         种子数（默认 10）；种子 = seed-base + i。
 *   --seed-base S     种子起点（默认 1），同种子集跨轮可比。
 *   --mirror          每个种子换边再跑一局（默认开；--no-mirror 关）——消除
 *                     先手/座位偏差，2p 对比必备。
 *   --concurrency K   局间并行（默认 4；局内行动天然串行。Kimi 网关限流
 *                     保守起见别调高）。
 *   --out dir         输出目录（默认 bench/out/run-<时间戳>）。
 *
 * LLM 座位需要 ANTHROPIC_API_KEY（经 AnthropicClient，走 ANTHROPIC_BASE_URL
 * 网关）；纯 heuristic 对局不需要 key，免费秒级。
 * 汇总：各标签胜率（平局各记 0.5）、平均 VP、平均 VP 差、degraded 率、token。
 */
import { AnthropicClient } from '../src/client.js';
import { HeuristicAgent } from '../src/heuristic.js';
import { LLMAgent } from '../src/llm-agent.js';
import { driveGame } from './drive-game.js';
import { TraceWriter, gameRecord } from './trace.js';
import { parseLlmSpec } from './variants.js';
const DIFFICULTIES = new Set(['easy', 'normal', 'hard']);
function parseArgs(argv) {
    const opts = {
        agentSpecs: ['llm:normal', 'heuristic'],
        games: 10,
        seedBase: 1,
        mirror: true,
        concurrency: 4,
        outDir: `bench/out/run-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const take = () => {
            const v = argv[++i];
            if (v === undefined)
                throw new Error(`${arg} 缺参数值`);
            return v;
        };
        switch (arg) {
            case '--agents':
                opts.agentSpecs = take().split(',');
                break;
            case '--games':
                opts.games = Number(take());
                break;
            case '--seed-base':
                opts.seedBase = Number(take());
                break;
            case '--mirror':
                opts.mirror = true;
                break;
            case '--no-mirror':
                opts.mirror = false;
                break;
            case '--concurrency':
                opts.concurrency = Number(take());
                break;
            case '--out':
                opts.outDir = take();
                break;
            case '--help':
                console.log('见本文件头注释。');
                process.exit(0);
            default:
                throw new Error(`未知参数: ${arg}（--help 看用法）`);
        }
    }
    if (!Number.isInteger(opts.games) || opts.games < 1) {
        throw new Error(`--games 须为正整数，收到 ${opts.games}`);
    }
    if (!Number.isInteger(opts.concurrency) ||
        opts.concurrency < 1 ||
        opts.concurrency > 16) {
        throw new Error(`--concurrency 须为 1..16，收到 ${opts.concurrency}`);
    }
    if (opts.agentSpecs.length < 2 || opts.agentSpecs.length > 4) {
        throw new Error(`--agents 须为 2..4 个座位，收到 ${opts.agentSpecs.length}`);
    }
    for (const spec of opts.agentSpecs) {
        if (spec === 'heuristic')
            continue;
        const parsed = parseLlmSpec(spec);
        if (!parsed || !DIFFICULTIES.has(parsed.difficulty)) {
            throw new Error(`未知 agent: ${spec}（支持 heuristic / llm:easy|normal|hard[@变体]）`);
        }
    }
    return opts;
}
/** agent 工厂：LLM 座位共用一个 AnthropicClient（无状态）；按 spec 构造。 */
function makeAgents(specs) {
    const needsLLM = specs.some((s) => s.startsWith('llm:'));
    // 网关环境可能用 AUTH_TOKEN 而非 API_KEY（SDK 两者皆认）——都放行。
    const authed = (process.env['ANTHROPIC_API_KEY'] ?? '') !== '' ||
        (process.env['ANTHROPIC_AUTH_TOKEN'] ?? '') !== '';
    if (needsLLM && !authed) {
        throw new Error('含 llm 座位须设 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN（纯 heuristic 对局不需要）');
    }
    const client = needsLLM ? new AnthropicClient() : null;
    const agents = specs.map((spec) => {
        if (spec === 'heuristic')
            return new HeuristicAgent();
        const parsed = parseLlmSpec(spec);
        if (!parsed || !DIFFICULTIES.has(parsed.difficulty)) {
            throw new Error(`未知 agent: ${spec}（支持 heuristic / llm:easy|normal|hard[@变体]）`);
        }
        return new LLMAgent(client, parsed.difficulty, undefined, parsed.systemExtra !== undefined ? { systemExtra: parsed.systemExtra } : undefined);
    });
    return { agents, labels: [...specs] };
}
function summarize(records, labels) {
    console.log('\n========== bench 汇总 ==========');
    console.log(`总局数: ${records.length}`);
    const unique = [...new Set(labels)];
    for (const label of unique) {
        let games = 0;
        let wins = 0;
        let vpSum = 0;
        let marginSum = 0;
        let degraded = 0;
        let decisions = 0;
        let negative = 0;
        let input = 0;
        let output = 0;
        for (const r of records) {
            r.seatLabels.forEach((l, seat) => {
                if (l !== label)
                    return;
                games++;
                if (r.winner === null)
                    wins += 0.5;
                else if (r.winner === seat)
                    wins += 1;
                const vp = r.vps[seat];
                const others = r.vps.filter((_, i) => i !== seat);
                vpSum += vp;
                marginSum += vp - Math.max(...others);
                if (vp < 0)
                    negative++;
                degraded += r.degraded[seat];
                decisions += r.steps / r.seatLabels.length;
                input += r.usage[seat].input;
                output += r.usage[seat].output;
            });
        }
        console.log(`${label}: 胜率 ${((wins / games) * 100).toFixed(1)}% (${wins}/${games})` +
            ` | 平均VP ${(vpSum / games).toFixed(1)}` +
            ` | 平均VP差 ${(marginSum / games).toFixed(1)}` +
            ` | 负分 ${((negative / games) * 100).toFixed(0)}%` +
            ` | degraded ${((degraded / Math.max(1, decisions)) * 100).toFixed(1)}%` +
            ` | token in=${input} out=${output}`);
    }
}
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const { agents, labels } = makeAgents(opts.agentSpecs);
    const playerCount = agents.length;
    const writer = new TraceWriter(opts.outDir);
    const tasks = [];
    for (let i = 0; i < opts.games; i++) {
        const seed = opts.seedBase + i;
        const base = agents.map((_, seat) => seat);
        tasks.push({ seed, mirrored: false, order: base });
        if (opts.mirror)
            tasks.push({ seed, mirrored: true, order: [...base].reverse() });
    }
    console.log(`[bench] ${tasks.length} 局（${opts.games} 种子${opts.mirror ? ' × 镜像' : ''}），` +
        `座位 ${labels.join(' vs ')}，并发 ${opts.concurrency}，输出 ${opts.outDir}`);
    const records = [];
    let next = 0;
    let done = 0;
    const worker = async () => {
        while (next < tasks.length) {
            const task = tasks[next++];
            const started = Date.now();
            // 每局重新构造 agent 实例，杜绝跨局隐式状态（当前实现均无状态，防御性）。
            const { agents: seatAgents } = makeAgents(task.order.map((seat) => opts.agentSpecs[seat]));
            const seatLabels = task.order.map((seat) => labels[seat]);
            const game = await driveGame(playerCount, task.seed, seatAgents);
            const record = gameRecord(game, seatLabels, task.mirrored, Date.now() - started);
            for (const d of game.decisions) {
                writer.decision({ ...d, seed: task.seed, mirrored: task.mirrored });
            }
            writer.game(record);
            records.push(record);
            done++;
            const vps = record.vps.map((v, i) => `P${i}(${seatLabels[i]})=${v}`).join(' ');
            console.log(`[bench ${done}/${tasks.length}] seed=${task.seed}` +
                `${task.mirrored ? ' 镜像' : ''} ${vps} 胜者=${record.winner ?? '平'}` +
                ` (${(record.durationMs / 1000).toFixed(0)}s)`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, tasks.length) }, worker));
    summarize(records, labels);
}
main().catch((e) => {
    console.error('[bench] 失败', e);
    process.exit(1);
});
