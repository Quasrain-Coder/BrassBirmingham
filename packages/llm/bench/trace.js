/**
 * bench 落盘：decisions.jsonl（每步决策一条）+ games.jsonl（每局一条）。
 *
 * 输出目录 bench/out/<runId>/（runId 由 CLI 给，默认时间戳）。纯 append
 * JSONL——中断也不丢已完成的局；log 重放走 newGame(seed) + applyAction
 * （action log 存在 DrivenGame.log，games.jsonl 里不重复存，重放需决策序列
 * 时由 analyze 从 decisions.jsonl 的 chosen 重建或直接重跑 driveGame）。
 */
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** 由 DrivenGame 汇总 GameRecord（VP 最高者胜，并列 null）。 */
export function gameRecord(game, seatLabels, mirrored, durationMs) {
    const vps = game.state.players.map((p) => p.vp);
    const best = Math.max(...vps);
    const winners = vps.flatMap((vp, i) => (vp === best ? [i] : []));
    const degraded = seatLabels.map(() => 0);
    const usage = seatLabels.map(() => ({ input: 0, output: 0 }));
    for (const d of game.decisions) {
        if (d.degraded)
            degraded[d.seat]++;
        usage[d.seat].input += d.usage.input;
        usage[d.seat].output += d.usage.output;
    }
    return {
        seed: game.seed,
        mirrored,
        seatLabels,
        vps,
        winner: winners.length === 1 ? winners[0] : null,
        steps: game.decisions.length,
        degraded,
        usage,
        durationMs,
    };
}
/** 追加写 JSONL 的落盘器；构造即建目录。 */
export class TraceWriter {
    decisionsPath;
    gamesPath;
    constructor(outDir) {
        mkdirSync(outDir, { recursive: true });
        this.decisionsPath = join(outDir, 'decisions.jsonl');
        this.gamesPath = join(outDir, 'games.jsonl');
        // 防污染：目录已存在且 games.jsonl 非空（上次跑批残留）→ 拒绝追加。
        // R1 迭代曾因复用 --out 目录把两次跑批的 JSONL 混在一起，去重前
        // 每局出现两次、VP 还不一致，直接导致汇总结论不可信（见 bench/out 历史）。
        if (existsSync(this.gamesPath) && statSync(this.gamesPath).size > 0) {
            throw new Error(`拒绝写 ${outDir}：games.jsonl 已非空（上次跑批残留）。` +
                `换新 --out 目录，或用空目录重试。`);
        }
    }
    decision(trace) {
        appendFileSync(this.decisionsPath, JSON.stringify(trace) + '\n');
    }
    game(record) {
        appendFileSync(this.gamesPath, JSON.stringify(record) + '\n');
    }
}
