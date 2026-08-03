import { describe, expect, it } from 'vitest';
import { RoomError, RoomManager, toRoomState } from '../src/rooms.js';

const CODE_FORBIDDEN = new Set(['0', 'O', '1', 'I', 'L']);

function fillRoom(rm: RoomManager, code: string, count: number, prefix = 'p') {
  const joined = [];
  for (let i = 1; i < count; i++) {
    joined.push(rm.joinRoom(code, `${prefix}${i}`));
  }
  return joined;
}

describe('RoomManager', () => {
  it('createRoom：建房者坐 seat 0，返回 24 字符 token 与未开始房间', () => {
    const rm = new RoomManager();
    const { room, seat, token } = rm.createRoom({ playerCount: 4 }, 'alice');
    expect(seat).toBe(0);
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(room.started).toBe(false);
    expect(room.seats).toHaveLength(4);
    expect(room.seats[0]?.nickname).toBe('alice');
    expect(room.seats[1]).toBeNull();
    expect(rm.getRoom(room.code)).toBe(room);
  });

  it('房间号：6 位大写字母数字，排除混淆字符 0O1IL', () => {
    const rm = new RoomManager();
    for (let i = 0; i < 30; i++) {
      const { room } = rm.createRoom({ playerCount: 2 }, `h${i}`);
      expect(room.code).toHaveLength(6);
      for (const ch of room.code) {
        expect(ch).toMatch(/[A-Z0-9]/);
        expect(CODE_FORBIDDEN.has(ch)).toBe(false);
      }
    }
  });

  it('joinRoom：按顺序补位，token 互不相同', () => {
    const rm = new RoomManager();
    const { room } = rm.createRoom({ playerCount: 3 }, 'alice');
    const j1 = rm.joinRoom(room.code, 'bob');
    const j2 = rm.joinRoom(room.code, 'carol');
    expect(j1.seat).toBe(1);
    expect(j2.seat).toBe(2);
    expect(room.seats[1]?.nickname).toBe('bob');
    expect(room.seats[2]?.nickname).toBe('carol');
    const tokens = new Set([j1.token, j2.token]);
    expect(tokens.size).toBe(2);
  });

  it('joinRoom：满员拒绝（room-full）', () => {
    const rm = new RoomManager();
    const { room } = rm.createRoom({ playerCount: 2 }, 'alice');
    rm.joinRoom(room.code, 'bob');
    expect(() => rm.joinRoom(room.code, 'carol')).toThrowError(
      expect.objectContaining({ code: 'room-full' }) as RoomError,
    );
  });

  it('joinRoom：房间不存在（room-not-found）', () => {
    const rm = new RoomManager();
    expect(() => rm.joinRoom('ZZZZZZ', 'bob')).toThrowError(
      expect.objectContaining({ code: 'room-not-found' }) as RoomError,
    );
  });

  it('getRoom：未知房间号返回 null', () => {
    const rm = new RoomManager();
    expect(rm.getRoom('ZZZZZZ')).toBeNull();
  });

  it('startGame：满员后可开始，started 置位，返回房间', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom({ playerCount: 2 }, 'alice');
    rm.joinRoom(room.code, 'bob');
    const started = rm.startGame(token);
    expect(started).toBe(room);
    expect(room.started).toBe(true);
  });

  it('startGame：任意座位成员均可开始（不限建房者）', () => {
    const rm = new RoomManager();
    const { room } = rm.createRoom({ playerCount: 2 }, 'alice');
    const { token: bobToken } = rm.joinRoom(room.code, 'bob');
    expect(() => rm.startGame(bobToken)).not.toThrow();
    expect(room.started).toBe(true);
  });

  it('startGame：人数不满拒绝（room-not-full）', () => {
    const rm = new RoomManager();
    const { token } = rm.createRoom({ playerCount: 3 }, 'alice');
    expect(() => rm.startGame(token)).toThrowError(
      expect.objectContaining({ code: 'room-not-full' }) as RoomError,
    );
  });

  it('startGame：非座位成员 token 拒绝（not-in-room）', () => {
    const rm = new RoomManager();
    rm.createRoom({ playerCount: 2 }, 'alice');
    expect(() => rm.startGame('x'.repeat(24))).toThrowError(
      expect.objectContaining({ code: 'not-in-room' }) as RoomError,
    );
  });

  it('重复开始：startGame 与 started 后 join 均拒绝（already-started）', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom({ playerCount: 2 }, 'alice');
    rm.joinRoom(room.code, 'bob');
    rm.startGame(token);
    expect(() => rm.startGame(token)).toThrowError(
      expect.objectContaining({ code: 'already-started' }) as RoomError,
    );
    expect(() => rm.joinRoom(room.code, 'carol')).toThrowError(
      expect.objectContaining({ code: 'already-started' }) as RoomError,
    );
  });

  it('token 唯一性：批量建房/加入无重复', () => {
    const rm = new RoomManager();
    const tokens = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { room, token } = rm.createRoom({ playerCount: 2 }, `h${i}`);
      tokens.add(token);
      tokens.add(rm.joinRoom(room.code, `g${i}`).token);
    }
    expect(tokens.size).toBe(80);
  });

  it('种子：config.seed 给定时 startGame 后原样落地', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom({ playerCount: 2, seed: 12345 }, 'alice');
    rm.joinRoom(room.code, 'bob');
    rm.startGame(token);
    expect(room.seed).toBe(12345);
  });

  it('种子：未给定时 startGame 用 crypto 随机生成并保存（确定性可复盘）', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom({ playerCount: 2 }, 'alice');
    rm.joinRoom(room.code, 'bob');
    expect(room.seed).toBeNull();
    rm.startGame(token);
    expect(typeof room.seed).toBe('number');
    expect(Number.isInteger(room.seed)).toBe(true);
  });

  it('昵称：空或超过 16 字符拒绝（invalid-nickname）', () => {
    const rm = new RoomManager();
    expect(() => rm.createRoom({ playerCount: 2 }, '')).toThrowError(
      expect.objectContaining({ code: 'invalid-nickname' }) as RoomError,
    );
    expect(() => rm.createRoom({ playerCount: 2 }, 'x'.repeat(17))).toThrowError(
      expect.objectContaining({ code: 'invalid-nickname' }) as RoomError,
    );
    const { room } = rm.createRoom({ playerCount: 2 }, 'ok');
    expect(() => rm.joinRoom(room.code, '  ')).toThrowError(
      expect.objectContaining({ code: 'invalid-nickname' }) as RoomError,
    );
    expect(() => rm.joinRoom(room.code, 'y'.repeat(16))).not.toThrow();
  });

  it('toRoomState：广播安全视图不含 token，结构符合协议 RoomState', () => {
    const rm = new RoomManager();
    const { room } = rm.createRoom({ playerCount: 2 }, 'alice');
    rm.joinRoom(room.code, 'bob');
    const state = toRoomState(room);
    expect(state.code).toBe(room.code);
    expect(state.config).toEqual({ playerCount: 2 });
    expect(state.started).toBe(false);
    expect(state.seats).toHaveLength(2);
    expect(state.seats[0]).toEqual({ seat: 0, nickname: 'alice', isAI: false, connected: true });
    expect(state.seats[1]).toEqual({ seat: 1, nickname: 'bob', isAI: false, connected: true });
    expect(JSON.stringify(state)).not.toContain('token');
  });
});
