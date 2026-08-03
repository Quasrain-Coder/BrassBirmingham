import type { Action, Card, GameState, PlayerIndex, PlayerState } from '@brass/engine';

export const PROTOCOL_VERSION = 1;

export { filterStateFor } from './filter.js';

// 房间配置与大厅
export interface RoomConfig { playerCount: 2|3|4; seed?: number }
export interface SeatInfo { seat: PlayerIndex; nickname: string; isAI: boolean; connected: boolean }
export interface RoomState { code: string; config: RoomConfig; customSeed: boolean; seats: (SeatInfo|null)[]; started: boolean }
// customSeed：client 供 seed 时 true（公开标记，大厅可展示"房主指定了种子"）；广播 config 不含 seed 值。

// 下行
export type ServerMessage =
  | { type: 'room_state'; protocolVersion: number; room: RoomState; yourSeat: PlayerIndex | null } // 广播安全：绝不含 token
  | { type: 'credentials'; protocolVersion: number; seat: PlayerIndex; token: string } // 仅 create/join/resume 时单发给本人
  | { type: 'snapshot'; protocolVersion: number; seq: number; state: FilteredState; legalActions: Action[] }
  | { type: 'action_applied'; protocolVersion: number; seq: number; player: PlayerIndex; action: Action; events: unknown[] }
  | { type: 'game_over'; protocolVersion: number; winner: PlayerIndex[]; finalScores: number[] } // finalScores = 终局 state.players[].vp 按座位序
  | { type: 'error'; protocolVersion: number; code: string; message: string }
  | { type: 'pong'; protocolVersion: number };

// FilteredState = GameState 按座位视角过滤（filter.ts filterStateFor 产出）：
// 他人手牌与牌堆只露数量，弃牌堆顶公开，rngState 移除防推算洗牌。
export type HandView = { kind: 'full'; cards: Card[] } | { kind: 'count'; count: number };
export type FilteredPlayerState = Omit<PlayerState, 'hand'> & { hand: HandView };
export type FilteredState = Omit<GameState, 'players'|'deck'|'discard'|'rngState'> & {
  players: FilteredPlayerState[];
  deck: { count: number };
  discard: { count: number; top: Card | null };
};

// 上行
export type ClientMessage =
  | { type: 'create_room'; protocolVersion: number; nickname: string; config: RoomConfig }
  | { type: 'join_room'; protocolVersion: number; code: string; nickname: string }
  | { type: 'start_game'; protocolVersion: number; token: string }
  | { type: 'submit_action'; protocolVersion: number; token: string; action: Action }
  | { type: 'resume'; protocolVersion: number; token: string }
  | { type: 'ping'; protocolVersion: number };
