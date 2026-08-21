/**
 * GameSession——权威对局会话：engine 裁决 + 每步落库 + 按座位视角快照。
 *
 * 职责边界（Task 5 brief）：
 * - 构造即开新局：engine newGame(playerCount, seed) + createGame 落库（games 行 + seats，
 *   roomCode 缺省取 gameId——真实房间码由 Task 6 WS 层传入）。
 * - submitAction 是状态推进的唯一入口，校验顺序：**game-finished → invalid-seat →
 *   not-your-turn → engine 合法性**。seat 校验（seat === turnOrder[currentPlayerIdx]）
 *   必须在本层做——engine 的 enumerateActions/applyAction 内部不做轮次校验（M1 经验）。
 * - engine 的 IllegalActionError 包装为 SessionError，原 code 透传（WS 层按 code 映射
 *   error 消息）；其余异常原样抛出（引擎 bug 不应被吞）。
 * - 每步 appendAction 落库（seq 从 0 递增）；append 成功后才替换内存态——落库失败
 *   （如同 gameId 重复开局）不留脏状态。终局（phase==='game-over'）finishGame 落
 *   final_state（完整 GameState，供 M5 复盘/重放）。
 * - snapshotFor(seat)：filterStateFor 隐藏信息裁剪；legalActions 仅当前玩家非空。
 *
 * 随机性：gameId 用 node:crypto（server 不受引擎种子约束）；对局内随机性全部来自
 * engine 种子（可重放）。
 */
import { randomBytes } from 'node:crypto';
import {
  IllegalActionError,
  applyAction,
  enumerateActions,
  newGame,
} from '@brass/engine';
import type { Action, Card, GameState, PlayerIndex } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import type { FilteredState } from '@brass/protocol';
import { appendAction, createGame, deleteActionsFrom, findGameById, finishGame, listActions, listSeats, type Db } from './db/repo.js';

/**
 * SessionError.code：'game-finished' / 'invalid-seat' / 'invalid-seats' / 'not-your-turn'
 * / engine IllegalActionError 原 code（如 'illegal-action'）。engine code 集合开放，
 * 故类型为 string——WS 层对未知 code 按透传处理。
 */
export class SessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

export interface SessionSeat {
  seat: PlayerIndex;
  nickname: string;
  token: string;
  /** AI 座位标记（落库 seats.is_ai；恢复对局时重建 agents 用）。缺省 false。 */
  isAI?: boolean;
}

export interface Snapshot {
  seq: number;
  state: FilteredState;
  legalActions: Action[];
  /** 各座位本时代已打出的牌（按打出顺序；Wild 弃置回供应区不入列）。 */
  playedCards: Card[][];
}

/** 'g_' + 8 字节 base64url（11 字符），crypto 随机。测试里应显式传 gameId。 */
export function generateGameId(): string {
  return `g_${randomBytes(8).toString('base64url')}`;
}

export class GameSession {
  readonly gameId: string;
  private readonly db: Db;
  private readonly seats: ReadonlySet<PlayerIndex>;
  private gameState: GameState;
  private seq = 0;
  /**
   * 回合备份：每个回合第 1 个行动前的状态引用(GameState 不可变,引用即快照)与
   * 当时 seq。供 resetTurn 撤销本回合全部行动(server 扣住回合期间可反悔)。
   */
  private turnBackup: { state: GameState; seq: number; played: Card[][] } | null = null;
  /**
   * 各座位本时代已打出的牌（按打出顺序）：实体弃牌堆公开规则的按玩家视图。
   * Wild 卡弃置回供应区不入列；时代切换时（弃牌合洗进新牌堆）清空重计。
   * resetTurn 撤销时同步回滚到回合初状态。
   */
  private playedThisEra: Card[][];

  constructor(
    db: Db,
    gameId: string | undefined,
    playerCount: 2 | 3 | 4,
    seed: number,
    seats: SessionSeat[],
    roomCode?: string,
    opts?: { persist?: boolean },
  ) {
    const expected = new Set(Array.from({ length: playerCount }, (_, i) => i as PlayerIndex));
    if (
      seats.length !== playerCount ||
      !seats.every((s) => expected.delete(s.seat)) ||
      expected.size !== 0
    ) {
      throw new SessionError(
        'invalid-seats',
        `seats 须恰好覆盖 0..${playerCount - 1}，收到 ${JSON.stringify(seats.map((s) => s.seat))}`,
      );
    }
    this.db = db;
    this.gameId = gameId ?? generateGameId();
    this.seats = new Set(seats.map((s) => s.seat));
    this.gameState = newGame(playerCount, seed);
    this.playedThisEra = seats.map(() => []);
    if (opts?.persist !== false) {
      createGame(db, {
        id: this.gameId,
        roomCode: roomCode ?? this.gameId,
        playerCount,
        seed,
        config: { playerCount, seed },
        seats,
      });
    }
  }

  /**
   * 服务器重启后的对局恢复：库中 status='playing' 的对局按 actions 表重放重建
   * （engine 确定性：newGame(seed) + 逐条 applyAction）。返回 null = 不可恢复
   * （对局不存在/已终局/重放校验失败），WS 层回 'session-lost'。
   * 注意：turnBackup 不恢复——恢复后当前回合的"重置本回合"不可用（下回合起正常）。
   */
  static restore(db: Db, gameId: string): GameSession | null {
    const game = findGameById(db, gameId);
    if (game === null || game.status !== 'playing') return null;
    const playerCount = game.playerCount;
    if (playerCount !== 2 && playerCount !== 3 && playerCount !== 4) return null;
    const seatRows = listSeats(db, gameId);
    const session = new GameSession(
      db,
      gameId,
      playerCount,
      game.seed,
      seatRows.map((s) => ({
        seat: s.seat as PlayerIndex,
        nickname: s.nickname,
        token: s.token,
        isAI: s.isAI,
      })),
      game.roomCode,
      { persist: false },
    );
    try {
      for (const { action } of listActions(db, gameId)) {
        session.recordPlayed(action);
        const eraBefore = session.gameState.era;
        session.gameState = applyAction(session.gameState, action);
        if (session.gameState.era !== eraBefore) {
          session.playedThisEra = session.playedThisEra.map(() => []);
        }
        session.seq += 1;
      }
    } catch {
      return null; // 重放失败（库脏数据/引擎语义漂移）——按不可恢复处理
    }
    return session;
  }

  /** 终局（engine phase==='game-over'，此刻 final_state 已落库）。 */
  get finished(): boolean {
    return this.gameState.phase === 'game-over';
  }

  /** 当前行动玩家（turnOrder[currentPlayerIdx]）。 */
  get currentSeat(): PlayerIndex {
    return this.gameState.turnOrder[this.gameState.currentPlayerIdx]!;
  }

  /**
   * 权威 GameState（只读约定，勿改）。服务端内部用：Task 6 广播 action_applied 需要
   * lastEvents、game_over 需要 winner 与 players[].vp；web 端一律走 snapshotFor。
   */
  get state(): GameState {
    return this.gameState;
  }

  /** 已落库行动数 = 下一个行动的 seq。 */
  get currentSeq(): number {
    return this.seq;
  }

  /**
   * 提交行动：校验 → engine applyAction 推进 → appendAction 落库（seq 递增）→
   * 终局则 finishGame 落 final_state。返回所落行动的 seq。
   */
  submitAction(seat: PlayerIndex, action: Action): { seq: number } {
    if (this.finished) {
      throw new SessionError('game-finished', `对局 ${this.gameId} 已结束，拒绝行动`);
    }
    this.assertSeat(seat);
    if (seat !== this.currentSeat) {
      throw new SessionError(
        'not-your-turn',
        `座位 ${seat} 非当前玩家（当前为 ${this.currentSeat}）`,
      );
    }
    let next: GameState;
    try {
      next = applyAction(this.gameState, action);
    } catch (e) {
      if (e instanceof IllegalActionError) {
        throw new SessionError(e.code, e.message);
      }
      throw e;
    }
    // 回合第 1 个行动前留下备份(应用前捕获;含本时代出牌记录,resetTurn 一并回滚)
    if (this.gameState.actionsThisTurn === 0) {
      this.turnBackup = {
        state: this.gameState,
        seq: this.seq,
        played: this.playedThisEra.map((l) => [...l]),
      };
    }
    this.recordPlayed(action);
    const eraBefore = this.gameState.era;
    appendAction(this.db, this.gameId, this.seq, seat, action);
    this.gameState = next;
    if (this.gameState.era !== eraBefore) {
      this.playedThisEra = this.playedThisEra.map(() => []); // 时代切换:弃牌合洗,重计
    }
    const applied = this.seq;
    this.seq += 1;
    if (this.finished) {
      finishGame(this.db, this.gameId, this.gameState);
    }
    return { seq: applied };
  }

  /**
   * 撤销当前回合：恢复到本回合第 1 个行动前的状态,删除已落库的本回合行动行。
   * 仅在"扣住回合"(turnHold)窗口内由 WS 层调用;无备份返回 false。
   */
  resetTurn(): boolean {
    if (this.turnBackup === null) return false;
    deleteActionsFrom(this.db, this.gameId, this.turnBackup.seq);
    this.gameState = this.turnBackup.state;
    this.seq = this.turnBackup.seq;
    this.playedThisEra = this.turnBackup.played;
    this.turnBackup = null;
    return true;
  }

  /**
   * 打出记录：行动消耗的牌（scout 为 3 张）按行动方座位入列，Wild 除外
   * （弃置回供应区而非弃牌堆）。须在 applyAction 之前调用（按应用前手牌查卡面）。
   */
  private recordPlayed(action: Action): void {
    const seat = this.currentSeat;
    const hand = this.gameState.players[seat]?.hand ?? [];
    const ids = action.type === 'scout' ? action.cardIds : [action.cardId];
    for (const id of ids) {
      const card = hand.find((c) => c.id === id);
      if (card === undefined) continue;
      if (card.kind === 'wild-location' || card.kind === 'wild-industry') continue;
      this.playedThisEra[seat]?.push(card);
    }
  }

  /** 按座位视角的快照；legalActions 仅当 seat 是当前玩家且对局未结束时非空。 */
  snapshotFor(seat: PlayerIndex): Snapshot {
    this.assertSeat(seat);
    return {
      seq: this.seq,
      state: filterStateFor(this.gameState, seat),
      legalActions:
        !this.finished && seat === this.currentSeat
          ? enumerateActions(this.gameState, seat)
          : [],
      playedCards: this.playedThisEra.map((l) => [...l]),
    };
  }

  private assertSeat(seat: PlayerIndex): void {
    if (!this.seats.has(seat)) {
      throw new SessionError('invalid-seat', `座位 ${seat} 不属于对局 ${this.gameId}`);
    }
  }
}
