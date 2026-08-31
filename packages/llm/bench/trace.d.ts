import type { DrivenGame, DecisionTrace } from './drive-game.js';
/** 一局的结果记录（games.jsonl 一行）。 */
export interface GameRecord {
    /** 本局种子（镜像局同种子、seatLabels 互换）。 */
    seed: number;
    /** 是否镜像换边局。 */
    mirrored: boolean;
    /** 座位 → agent 标签（如 ["llm:normal", "heuristic"]）。 */
    seatLabels: string[];
    /** 座位 → 终局 VP。 */
    vps: number[];
    /** 胜者优先级最高座位；平局为 null。 */
    winner: number | null;
    /** 总步数（= 决策数）。 */
    steps: number;
    /** 座位 → degraded 决策数。 */
    degraded: number[];
    /** 座位 → token 用量合计。 */
    usage: {
        input: number;
        output: number;
    }[];
    durationMs: number;
}
/** 由 DrivenGame 汇总 GameRecord（VP 最高者胜，并列 null）。 */
export declare function gameRecord(game: DrivenGame, seatLabels: string[], mirrored: boolean, durationMs: number): GameRecord;
/** 追加写 JSONL 的落盘器；构造即建目录。 */
export declare class TraceWriter {
    private readonly decisionsPath;
    private readonly gamesPath;
    constructor(outDir: string);
    decision(trace: DecisionTrace & {
        seed: number;
        mirrored: boolean;
    }): void;
    game(record: GameRecord): void;
}
