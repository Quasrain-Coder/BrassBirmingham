/**
 * bench 异步整局驱动——engine `playGame`（agents/random.ts）的 async 变体。
 *
 * playGame 只接受同步 PlayerAgent，驱动不了 async DecidingAgent（LLMAgent 要
 * 等 HTTP）。循环体与 playGame 同构（newGame → enumerateActions → decide →
 * applyAction → 记 log，同 MAX_STEPS 防御上限），座位注入 DecidingAgent[]，
 * HeuristicAgent / LLMAgent 同接口，天然支持混编对局（llm vs heuristic）。
 *
 * 每步顺手记 DecisionTrace：除决策结果（chosen/reason/degraded/usage）外，
 * 记录 chosenRank（所选在 scoreAction 降序中的名次，0 = 启发式最优）与
 * heuristicTop（启发式最优描述）——失败分析的对照锚点：LLM 长期偏离 rank 0
 * 且输棋 → 候选内选错（改 prompt）；chosenRank 恒 0 → LLM 无增量（预筛即上限）。
 */
import { type Action, type GameState, type PlayerIndex } from '@brass/engine';
import type { DecidingAgent } from '../src/decision.js';
/** 单步决策记录（games.jsonl 之外另落 decisions.jsonl）。 */
export interface DecisionTrace {
    seq: number;
    seat: PlayerIndex;
    era: GameState['era'];
    round: number;
    /** 合法行动总数（LLM 的候选为其中 prescreen TopK）。 */
    legalCount: number;
    /** 所选行动在 scoreAction 降序名次（0 起；-1 = 不在 legal 内，引擎会拒，不应出现）。 */
    chosenRank: number;
    /** 启发式最优行动描述（对照锚点）。 */
    heuristicTop: string;
    /** 所选行动描述。 */
    chosen: string;
    reason: string;
    degraded: boolean;
    usage: {
        input: number;
        output: number;
    };
}
export interface DrivenGame {
    seed: number;
    /** 终局状态（VP/胜者在 state.players[*].vp）。 */
    state: GameState;
    /** 完整 action log：newGame(同 seed) + 逐条 applyAction 可纯重放。 */
    log: Action[];
    decisions: DecisionTrace[];
}
/**
 * 所选行动在"LLM 可见候选集"（prescreen 消毒+去重后）scoreAction 降序中的名次。
 * 引用比较优先，退化稳定序列化比较。
 *
 * 语义：衡量"模型在它看到的候选里选得好不好"。用全量 legal 会把被消毒剔除的
 * 自杀贷款也算进去——那种贷款模型根本看不到，rank 失真（baseline-llm 实测
 * 开局的启发式最优常是 0→-3 的贷款，而模型不该被要求选它）。
 */
export declare function rankOf(state: GameState, player: PlayerIndex, legal: Action[], chosen: Action): {
    rank: number;
    top: Action;
};
/**
 * 异步驱动一整局。agents 长度须等于 playerCount；decide 抛异常向上传
 * （LLMAgent 内部有降级兜底不抛；驱动层不吞错——bench 要暴露真问题）。
 */
export declare function driveGame(playerCount: 2 | 3 | 4, seed: number, agents: DecidingAgent[]): Promise<DrivenGame>;
