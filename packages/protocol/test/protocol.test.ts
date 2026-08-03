import { describe, expect, it } from 'vitest';
import { newGame, type Action, type GameState, type PlayerIndex } from '@brass/engine';
import { filterStateFor } from '../src/filter.js';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type FilteredState,
  type RoomConfig,
  type RoomState,
  type SeatInfo,
  type ServerMessage,
} from '../src/index.js';

// 编译期断言辅助：condition 为 false 时该类型不可赋值，tsc 直接报错
type Assert<T extends true> = T;
type HasKey<T, K extends string> = K extends keyof T ? true : false;

type RoomStateMessage = Extract<ServerMessage, { type: 'room_state' }>;

// 广播安全：room_state 消息本体与其嵌套的 RoomState/SeatInfo/RoomConfig 均不得出现 token 字段
// 若任一层含 token，HasKey<...> 为 true，条件类型落到 Assert<false>，tsc 编译失败
type _noToken1 = Assert<HasKey<RoomStateMessage, 'token'> extends false ? true : false>;
type _noToken2 = Assert<HasKey<RoomState, 'token'> extends false ? true : false>;
type _noToken3 = Assert<HasKey<SeatInfo, 'token'> extends false ? true : false>;
type _noToken4 = Assert<HasKey<RoomConfig, 'token'> extends false ? true : false>;

// 类型导出存在性（编译期锚定）
type _roomStateShape = Assert<RoomState extends { code: string; started: boolean } ? true : false>;
type _filteredStateShape = Assert<FilteredState extends { players: unknown[]; deck: { count: number }; discard: { count: number } } ? true : false>;
const _usesEngineTypes: { a?: Action; g?: GameState; p?: PlayerIndex } = {};
void _usesEngineTypes;

describe('protocol', () => {
  it('PROTOCOL_VERSION === 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('room_state 消息（含嵌套类型）运行时键中无 token 字段——广播安全', () => {
    const room: RoomState = {
      code: 'ABCD',
      config: { playerCount: 4 },
      seats: [{ seat: 0, nickname: 'alice', isAI: false, connected: true }, null, null, null],
      started: false,
    };
    const msg: ServerMessage = { type: 'room_state', protocolVersion: PROTOCOL_VERSION, room, yourSeat: 0 };
    const json = JSON.stringify(msg);
    expect(json).not.toContain('token');
    expect(Object.keys(msg).sort()).toEqual(['protocolVersion', 'room', 'type', 'yourSeat']);
    expect(Object.keys(room).sort()).toEqual(['code', 'config', 'seats', 'started']);
  });

  it('上下行消息可构造且可 JSON 序列化', () => {
    const up: ClientMessage[] = [
      { type: 'create_room', protocolVersion: PROTOCOL_VERSION, nickname: 'a', config: { playerCount: 2, seed: 42 } },
      { type: 'join_room', protocolVersion: PROTOCOL_VERSION, code: 'ABCD', nickname: 'b' },
      { type: 'start_game', protocolVersion: PROTOCOL_VERSION, token: 't' },
      { type: 'resume', protocolVersion: PROTOCOL_VERSION, token: 't' },
      { type: 'ping', protocolVersion: PROTOCOL_VERSION },
    ];
    const down: ServerMessage[] = [
      { type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat: 0, token: 't' },
      { type: 'snapshot', protocolVersion: PROTOCOL_VERSION, seq: 1, state: filterStateFor(newGame(2, 42), 0), legalActions: [] },
      { type: 'game_over', protocolVersion: PROTOCOL_VERSION, winner: [0], finalScores: [100, 90] },
      { type: 'error', protocolVersion: PROTOCOL_VERSION, code: 'E', message: 'm' },
      { type: 'pong', protocolVersion: PROTOCOL_VERSION },
    ];
    for (const m of [...up, ...down]) {
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    }
  });
});
