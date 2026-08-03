/**
 * PlayerAgent 接口、均匀随机 RandomAgent 与整局驱动 playGame。
 *
 * - RandomAgent 构造独立种子 RNG（createRng），chooseAction 在合法行动集内均匀
 *   随机选一；同一 agent 种子序列完全可复现。
 * - playGame(playerCount, seed, agents?)：newGame 后循环（枚举合法行动 → 当前
 *   玩家 agent 选择 → applyAction → 记入 log）直到 phase='game-over'。
 *   默认按座位确定性派生 agent 种子：seed * 10 + seatIndex——同一 (playerCount,
 *   seed) 必现同一局，log 可用 newGame(同种子) + 逐条 applyAction 纯重放。
 * - applyAction 的合法性校验（重枚举比对）全程保持开启，是 fuzz 的主要断言之一。
 */
import { applyAction, enumerateActions } from '../apply.js';
import { createRng, type Rng } from '../rng.js';
import { newGame, type GameState } from '../state.js';
import type { Action, PlayerIndex } from '../types.js';

export interface PlayerAgent {
  chooseAction(state: GameState, legal: Action[]): Action;
}

export class RandomAgent implements PlayerAgent {
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = createRng(seed);
  }

  chooseAction(_state: GameState, legal: Action[]): Action {
    if (legal.length === 0) {
      throw new Error('RandomAgent.chooseAction: no legal actions');
    }
    return legal[this.rng.nextInt(legal.length)]!;
  }
}

/** 防御性上限：正常对局远小于此（§4 轮数有界），超限即引擎死循环。 */
const MAX_STEPS = 100_000;

export function playGame(
  playerCount: 2 | 3 | 4,
  seed: number,
  agents?: PlayerAgent[],
): { state: GameState; log: Action[] } {
  const seats: PlayerAgent[] =
    agents ??
    Array.from({ length: playerCount }, (_, i) => new RandomAgent(seed * 10 + i));
  if (seats.length !== playerCount) {
    throw new Error(`playGame: need ${playerCount} agents, got ${seats.length}`);
  }

  let state = newGame(playerCount, seed);
  const log: Action[] = [];
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player: PlayerIndex = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    if (legal.length === 0) {
      throw new Error(
        `playGame: no legal actions for player ${player} ` +
          `(seed ${seed}, step ${steps}, era ${state.era}, round ${state.round})`,
      );
    }
    const action = seats[player]!.chooseAction(state, legal);
    state = applyAction(state, action);
    log.push(action);
    if (++steps > MAX_STEPS) {
      throw new Error(
        `playGame: exceeded ${MAX_STEPS} steps without game-over (seed ${seed})`,
      );
    }
  }
  return { state, log };
}
