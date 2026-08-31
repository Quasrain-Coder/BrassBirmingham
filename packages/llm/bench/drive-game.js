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
import { applyAction, enumerateActions, newGame, stableStringify, } from '@brass/engine';
import { prescreen, scoreAction } from '../src/heuristic.js';
import { describeAction } from '../src/summarize.js';
/** 与 playGame 同一防御上限：正常对局远小于此，超限即引擎死循环。 */
const MAX_STEPS = 100_000;
/**
 * 所选行动在"LLM 可见候选集"（prescreen 消毒+去重后）scoreAction 降序中的名次。
 * 引用比较优先，退化稳定序列化比较。
 *
 * 语义：衡量"模型在它看到的候选里选得好不好"。用全量 legal 会把被消毒剔除的
 * 自杀贷款也算进去——那种贷款模型根本看不到，rank 失真（baseline-llm 实测
 * 开局的启发式最优常是 0→-3 的贷款，而模型不该被要求选它）。
 */
export function rankOf(state, player, legal, chosen) {
    const candidates = prescreen(state, player, legal, legal.length);
    const scored = candidates
        .map((action, index) => ({ action, index, score: scoreAction(state, player, action) }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
    let rank = scored.findIndex((x) => x.action === chosen);
    if (rank === -1) {
        const key = stableStringify(chosen);
        rank = scored.findIndex((x) => stableStringify(x.action) === key);
    }
    return { rank, top: scored[0].action };
}
/**
 * 异步驱动一整局。agents 长度须等于 playerCount；decide 抛异常向上传
 * （LLMAgent 内部有降级兜底不抛；驱动层不吞错——bench 要暴露真问题）。
 */
export async function driveGame(playerCount, seed, agents) {
    if (agents.length !== playerCount) {
        throw new Error(`driveGame: need ${playerCount} agents, got ${agents.length}`);
    }
    let state = newGame(playerCount, seed);
    const log = [];
    const decisions = [];
    let steps = 0;
    while (state.phase !== 'game-over') {
        const player = state.turnOrder[state.currentPlayerIdx];
        const legal = enumerateActions(state, player);
        if (legal.length === 0) {
            throw new Error(`driveGame: no legal actions for player ${player} ` +
                `(seed ${seed}, step ${steps}, era ${state.era}, round ${state.round})`);
        }
        const d = await agents[player].decide(state, player, legal);
        const { rank, top } = rankOf(state, player, legal, d.action);
        decisions.push({
            seq: steps,
            seat: player,
            era: state.era,
            round: state.round,
            legalCount: legal.length,
            chosenRank: rank,
            heuristicTop: describeAction(state, player, top),
            chosen: describeAction(state, player, d.action),
            reason: d.reason,
            degraded: d.degraded,
            usage: d.usage,
        });
        state = applyAction(state, d.action);
        log.push(d.action);
        if (++steps > MAX_STEPS) {
            throw new Error(`driveGame: exceeded ${MAX_STEPS} steps without game-over (seed ${seed})`);
        }
    }
    return { seed, state, log, decisions };
}
