/**
 * 房间管理器（内存态大厅）。Task 5 在其上挂 GameSession 与持久化。
 *
 * 裁决（task-4 brief）：startGame 要求满员；任意座位成员可开始（AI 座位 M3 再加）。
 * 随机性一律用 node:crypto——server 不受引擎种子约束；engine 种子在 startGame 时落地
 * （config.seed 未给则 crypto 随机生成并保存，重放/复盘需要确定性种子）。
 */
import { randomBytes } from 'node:crypto';
import type { PlayerIndex } from '@brass/engine';
import type { RoomConfig, RoomState } from '@brass/protocol';

export type RoomErrorCode =
  | 'room-full'
  | 'room-not-found'
  | 'already-started'
  | 'not-in-room'
  | 'room-not-full'
  | 'invalid-nickname'
  | 'invalid-config'
  | 'code-exhausted';

/** 与 engine 的 IllegalActionError 同模式：code 机器可读，供 WS 层映射 error 消息。 */
export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

/** 内部座位：含 token，绝不直接广播（广播用 toRoomState）。 */
export interface Seat {
  seat: PlayerIndex;
  nickname: string;
  token: string;
  connected: boolean;
}

export interface Room {
  readonly code: string;
  readonly config: RoomConfig;
  readonly seats: (Seat | null)[];
  started: boolean;
  /** engine 种子，startGame 时落地；开始前为 null。 */
  seed: number | null;
  /** client 供 seed 时 true——公开标记，大厅可展示"房主指定了种子"（防作弊通道透明化）。 */
  readonly customSeed: boolean;
}

export interface JoinResult {
  room: Room;
  seat: PlayerIndex;
  token: string;
}

/** 房间号字符集：大写字母数字去掉混淆字符 0O1IL（31 个）。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_CODE_RETRIES = 100;
const NICKNAME_MAX = 16;

/** 广播安全视图：剥掉 token 与 config.seed（防推算洗牌），只留协议 RoomState 字段。 */
export function toRoomState(room: Room): RoomState {
  return {
    code: room.code,
    config: { playerCount: room.config.playerCount },
    customSeed: room.customSeed,
    seats: room.seats.map((s) =>
      s === null ? null : { seat: s.seat, nickname: s.nickname, isAI: false, connected: s.connected },
    ),
    started: room.started,
  };
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly tokenIndex = new Map<string, Room>();

  createRoom(config: RoomConfig, nickname: string): JoinResult {
    const name = validateNickname(nickname);
    if (config.playerCount !== 2 && config.playerCount !== 3 && config.playerCount !== 4) {
      throw new RoomError('invalid-config', `playerCount 须为 2/3/4，收到 ${config.playerCount}`);
    }
    const code = this.generateCode();
    const token = generateToken();
    // 浅拷贝 config，防调用方后续 mutate 影响房间
    const configCopy: RoomConfig = { ...config };
    const seats: (Seat | null)[] = Array.from({ length: config.playerCount }, () => null);
    seats[0] = { seat: 0, nickname: name, token, connected: true };
    const room: Room = {
      code,
      config: configCopy,
      seats,
      started: false,
      seed: null,
      customSeed: configCopy.seed !== undefined,
    };
    this.rooms.set(code, room);
    this.tokenIndex.set(token, room);
    return { room, seat: 0, token };
  }

  joinRoom(code: string, nickname: string): JoinResult {
    const name = validateNickname(nickname);
    const room = this.rooms.get(code.toUpperCase());
    if (room === undefined) {
      throw new RoomError('room-not-found', `房间不存在: ${code}`);
    }
    if (room.started) {
      throw new RoomError('already-started', `房间 ${room.code} 已开始，拒绝加入`);
    }
    const seat = room.seats.indexOf(null);
    if (seat === -1) {
      throw new RoomError('room-full', `房间 ${room.code} 已满员`);
    }
    const token = generateToken();
    room.seats[seat] = { seat, nickname: name, token, connected: true };
    this.tokenIndex.set(token, room);
    return { room, seat, token };
  }

  /** 满员校验 + 种子落地；返回房间（GameSession 是 Task 5）。 */
  startGame(token: string): Room {
    const room = this.tokenIndex.get(token);
    if (room === undefined) {
      throw new RoomError('not-in-room', 'token 不属于任何房间座位');
    }
    if (room.started) {
      throw new RoomError('already-started', `房间 ${room.code} 已开始`);
    }
    if (room.seats.includes(null)) {
      throw new RoomError('room-not-full', `房间 ${room.code} 未满员（M2 要求满员开始）`);
    }
    room.started = true;
    room.seed = room.config.seed ?? randomSeed();
    return room;
  }

  getRoom(code: string): Room | null {
    return this.rooms.get(code.toUpperCase()) ?? null;
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
      let code = '';
      const bytes = randomBytes(CODE_LENGTH);
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new RoomError('code-exhausted', '房间号分配失败（重试耗尽）');
  }
}

/** 24 字符 base64url（18 字节随机）。 */
function generateToken(): string {
  return randomBytes(18).toString('base64url');
}

function randomSeed(): number {
  return randomBytes(4).readUInt32LE(0);
}

function validateNickname(nickname: string): string {
  const name = nickname.trim();
  if (name.length < 1 || name.length > NICKNAME_MAX) {
    throw new RoomError('invalid-nickname', `昵称长度须为 1-${NICKNAME_MAX} 字符`);
  }
  return name;
}
