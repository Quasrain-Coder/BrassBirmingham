import type { Action, GameState, PlayerIndex } from '@brass/engine';

export const PROTOCOL_VERSION = 1;

// 房间配置与大厅
export interface RoomConfig { playerCount: 2|3|4; seed?: number }
export interface SeatInfo { seat: PlayerIndex; nickname: string; isAI: boolean; connected: boolean }
export interface RoomState { code: string; config: RoomConfig; seats: (SeatInfo|null)[]; started: boolean }

// 下行
export type ServerMessage =
  | { type: 'room_state'; protocolVersion: number; room: RoomState; yourSeat: PlayerIndex | null } // 广播安全：绝不含 token
  | { type: 'credentials'; protocolVersion: number; seat: PlayerIndex; token: string } // 仅 create/join/resume 时单发给本人
  | { type: 'snapshot'; protocolVersion: number; seq: number; state: FilteredState; legalActions: Action[] }
  | { type: 'action_applied'; protocolVersion: number; seq: number; player: PlayerIndex; action: Action; events: unknown[] }
  | { type: 'game_over'; protocolVersion: number; winner: PlayerIndex[]; finalScores: number[] } // finalScores = 终局 state.players[].vp 按座位序
  | { type: 'error'; protocolVersion: number; code: string; message: string }
  | { type: 'pong'; protocolVersion: number };

// FilteredState = GameState 视角过滤（Task 2 定义精确形状）
export type FilteredState = unknown; // Task 2 替换为精确类型

// 上行
export type ClientMessage =
  | { type: 'create_room'; protocolVersion: number; nickname: string; config: RoomConfig }
  | { type: 'join_room'; protocolVersion: number; code: string; nickname: string }
  | { type: 'start_game'; protocolVersion: number; token: string }
  | { type: 'submit_action'; protocolVersion: number; token: string; action: Action }
  | { type: 'resume'; protocolVersion: number; token: string }
  | { type: 'ping'; protocolVersion: number };
