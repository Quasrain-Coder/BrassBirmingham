/**
 * 统一决策接口（Task 3/4 共用，server 只依赖它）。
 *
 * - Decision：一次选牌的完整结果——action 永远来自调用方给的 legal 集；
 *   degraded=true 表示非 LLM 降级路径（启发式/随机兜底）；usage 为 token 用量
 *   （降级路径恒 0）。
 * - DecidingAgent：LLMAgent 与 HeuristicAgent 共同实现，server 按此接口驱动 AI 座位。
 */
import type { Action, GameState, PlayerIndex } from '@brass/engine';

export interface Decision {
  action: Action;
  reason: string;
  degraded: boolean;
  usage: { input: number; output: number };
}

export interface DecidingAgent {
  decide(
    state: GameState,
    player: PlayerIndex,
    legal: Action[],
  ): Promise<Decision>;
}
