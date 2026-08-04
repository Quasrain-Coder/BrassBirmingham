/**
 * GameClient / GameStore 单测（M2 Task 10 Step 1）。
 * FakeWebSocket 注入替代原生 ws：消息 → 状态迁移、断线重连自动 resume、
 * 同 token 被踢（服务器主动 close）后自动回连。
 */
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@brass/protocol';
import type { RoomState, ServerMessage } from '@brass/protocol';
import { newGame } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import {
  GameClient,
  GameStore,
  useGameStore,
  type WebSocketLike,
} from './store';

/** 测试用假 ws：记录发送帧，手动触发 open/message/close。 */
class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  // ---- 测试驱动方法 ----
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** 服务器侧被动断开（心跳超时 / 同 token resume 踢连接）。 */
  serverClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  lastSent(): unknown {
    const raw = this.sent[this.sent.length - 1];
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

/** 内存版 SessionStorageLike：模拟 localStorage（key 枚举按插入序）。 */
class FakeStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

function setup(
  reconnectDelayMs = 0,
  opts: { storage?: FakeStorage; tabId?: string } = {},
): { store: GameStore; storage: FakeStorage } {
  FakeWebSocket.instances = [];
  const storage = opts.storage ?? new FakeStorage();
  const client = new GameClient('ws://test/ws', (url) => new FakeWebSocket(url));
  const store = new GameStore(client, {
    reconnectDelayMs,
    storage,
    tabId: opts.tabId ?? 'tab-A',
  });
  return { store, storage };
}

function lastWs(): FakeWebSocket {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (ws === undefined) throw new Error('尚未创建任何 FakeWebSocket');
  return ws;
}

function roomFixture(): RoomState {
  return {
    code: 'ABCD',
    config: { playerCount: 4 },
    customSeed: false,
    seats: [
      { seat: 0, nickname: '甲', isAI: false, connected: true },
      { seat: 1, nickname: '乙', isAI: false, connected: true },
      { seat: 2, nickname: '丙', isAI: false, connected: true },
      { seat: 3, nickname: '丁', isAI: false, connected: true },
    ],
    started: false,
  };
}

/** 等一个 macrotask，让 reconnectDelayMs=0 的重连定时器先跑完。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('GameStore 状态迁移', () => {
  it('初始为 disconnected，各字段为空', () => {
    const { store } = setup();
    const s = store.getState();
    expect(s.connection).toBe('disconnected');
    expect(s.room).toBeNull();
    expect(s.seat).toBeNull();
    expect(s.token).toBeNull();
    expect(s.snapshot).toBeNull();
    expect(s.legalActions).toEqual([]);
    expect(s.seq).toBe(0);
    expect(s.log).toEqual([]);
    expect(s.gameOver).toBeNull();
    expect(s.selectedCard).toBeNull();
    expect(s.takenOver).toBe(false);
  });

  it('connect → connecting；ws open → connected', () => {
    const { store } = setup();
    store.connect();
    expect(store.getState().connection).toBe('connecting');
    lastWs().open();
    expect(store.getState().connection).toBe('connected');
  });

  it('已 connected 时再 connect() 为空操作（不回到 connecting、不新建 ws）', () => {
    const { store } = setup();
    store.connect();
    lastWs().open();
    const n = FakeWebSocket.instances.length;
    store.connect();
    expect(store.getState().connection).toBe('connected');
    expect(FakeWebSocket.instances).toHaveLength(n);
  });

  it('room_state 更新 room 与 yourSeat', () => {
    const { store } = setup();
    store.connect();
    const ws = lastWs();
    ws.open();
    ws.emit({
      type: 'room_state',
      protocolVersion: PROTOCOL_VERSION,
      room: roomFixture(),
      yourSeat: 2,
    });
    const s = store.getState();
    expect(s.room?.code).toBe('ABCD');
    expect(s.seat).toBe(2);
  });

  it('credentials 记录 token 与 seat', () => {
    const { store } = setup();
    store.connect();
    const ws = lastWs();
    ws.open();
    ws.emit({ type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat: 1, token: 'tok-1' });
    expect(store.getState().token).toBe('tok-1');
    expect(store.getState().seat).toBe(1);
  });

  it('snapshot 更新 snapshot/legalActions/seq', () => {
    const { store } = setup();
    store.connect();
    const ws = lastWs();
    ws.open();
    const filtered = filterStateFor(newGame(4, 42), 0);
    const legalActions = [{ type: 'loan' as const, cardId: 'c0' }];
    ws.emit({
      type: 'snapshot',
      protocolVersion: PROTOCOL_VERSION,
      seq: 7,
      state: filtered,
      legalActions,
    });
    const s = store.getState();
    // 消息经 JSON 序列化往返，按值比较而非引用
    expect(s.snapshot).toStrictEqual(filtered);
    expect(s.legalActions).toEqual(legalActions);
    expect(s.seq).toBe(7);
  });

  it('action_applied 追加日志，环形缓冲保留最新 100 条', () => {
    const { store } = setup();
    store.connect();
    const ws = lastWs();
    ws.open();
    for (let i = 0; i < 105; i++) {
      ws.emit({
        type: 'action_applied',
        protocolVersion: PROTOCOL_VERSION,
        seq: i,
        player: i % 4,
        action: { type: 'pass', cardId: `c${i}` },
        events: [],
      });
    }
    const log = store.getState().log;
    expect(log).toHaveLength(100);
    expect(log[0]?.seq).toBe(5);
    expect(log[99]?.seq).toBe(104);
    expect(log[99]?.action.type).toBe('pass');
  });

  it('game_over 记录 winner 与 finalScores；error 记录 lastError', () => {
    const { store } = setup();
    store.connect();
    const ws = lastWs();
    ws.open();
    ws.emit({ type: 'error', protocolVersion: PROTOCOL_VERSION, code: 'not-your-turn', message: '没轮到你' });
    expect(store.getState().lastError).toEqual({ code: 'not-your-turn', message: '没轮到你' });
    ws.emit({ type: 'game_over', protocolVersion: PROTOCOL_VERSION, winner: [1], finalScores: [80, 95, 70, 60] });
    expect(store.getState().gameOver).toEqual({ winner: [1], finalScores: [80, 95, 70, 60] });
  });

  it('非法 JSON 帧被忽略，不影响后续消息', () => {
    const { store } = setup();
    store.connect();
    const ws = lastWs();
    ws.open();
    ws.onmessage?.({ data: '{not-json' });
    ws.emit({ type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat: 0, token: 't' });
    expect(store.getState().token).toBe('t');
  });
});

describe('GameStore 上行消息', () => {
  it('createRoom / joinRoom 发送带版本号的上行帧', () => {
    const { store } = setup();
    store.connect();
    const ws = lastWs();
    ws.open();
    store.createRoom('甲', { playerCount: 4 });
    expect(ws.lastSent()).toEqual({
      type: 'create_room',
      protocolVersion: PROTOCOL_VERSION,
      nickname: '甲',
      config: { playerCount: 4 },
    });
    store.joinRoom('ABCD', '乙');
    expect(ws.lastSent()).toEqual({
      type: 'join_room',
      protocolVersion: PROTOCOL_VERSION,
      code: 'ABCD',
      nickname: '乙',
    });
  });

  it('startGame / submitAction 自动带 token；submitAction 清空 selectedCard', () => {
    const { store } = setup();
    store.connect();
    const ws = lastWs();
    ws.open();
    ws.emit({ type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat: 0, token: 'tok-9' });
    store.startGame();
    expect(ws.lastSent()).toEqual({ type: 'start_game', protocolVersion: PROTOCOL_VERSION, token: 'tok-9' });
    store.selectCard('c1');
    expect(store.getState().selectedCard).toBe('c1');
    store.submitAction({ type: 'pass', cardId: 'c1' });
    expect(ws.lastSent()).toEqual({
      type: 'submit_action',
      protocolVersion: PROTOCOL_VERSION,
      token: 'tok-9',
      action: { type: 'pass', cardId: 'c1' },
    });
    expect(store.getState().selectedCard).toBeNull();
  });

  it('未持 token 时 startGame / submitAction 抛错且不发帧', () => {
    const { store } = setup();
    store.connect();
    const ws = lastWs();
    ws.open();
    expect(() => store.startGame()).toThrow(/token/);
    expect(() => store.submitAction({ type: 'pass', cardId: 'c' })).toThrow(/token/);
    expect(ws.sent).toHaveLength(0);
  });
});

describe('GameStore 断线与重连', () => {
  it('被动 close → disconnected，随后自动重连', async () => {
    const { store } = setup();
    store.connect();
    lastWs().open();
    expect(store.getState().connection).toBe('connected');
    lastWs().serverClose();
    expect(store.getState().connection).toBe('disconnected');
    await tick();
    expect(store.getState().connection).toBe('connecting');
    expect(FakeWebSocket.instances).toHaveLength(2);
    lastWs().open();
    expect(store.getState().connection).toBe('connected');
  });

  it('持 token 重连成功后自动发 resume（容忍同 token 被踢的被动 close）', async () => {
    const { store } = setup();
    store.connect();
    const ws1 = lastWs();
    ws1.open();
    ws1.emit({ type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat: 1, token: 'tok-kick' });
    // 另一标签页用同 token resume → 服务器踢掉本连接（无 connected=false 广播）
    ws1.serverClose();
    await tick();
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws1);
    ws2.open();
    expect(ws2.lastSent()).toEqual({ type: 'resume', protocolVersion: PROTOCOL_VERSION, token: 'tok-kick' });
  });

  it('disconnect 为主动关闭：不触发自动重连', async () => {
    const { store } = setup();
    store.connect();
    lastWs().open();
    store.disconnect();
    expect(store.getState().connection).toBe('disconnected');
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('disconnect 取消等待中的重连定时器', async () => {
    const { store } = setup(10_000);
    store.connect();
    lastWs().open();
    lastWs().serverClose();
    store.disconnect();
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(store.getState().connection).toBe('disconnected');
  });
});

describe('GameClient', () => {
  it('未 open 时 send 抛错', () => {
    FakeWebSocket.instances = [];
    const client = new GameClient('ws://test/ws', (url) => new FakeWebSocket(url));
    client.connect();
    expect(() =>
      client.send({ type: 'ping', protocolVersion: PROTOCOL_VERSION }),
    ).toThrow(/未连接/);
  });

  it('重复 connect 不重复建连（connecting/open 幂等）', () => {
    FakeWebSocket.instances = [];
    const client = new GameClient('ws://test/ws', (url) => new FakeWebSocket(url));
    client.connect();
    client.connect();
    lastWs().open();
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('useGameStore', () => {
  it('组件读到最新状态并随消息更新', () => {
    const { store } = setup();
    const { result } = renderHook(() => useGameStore(store));
    expect(result.current.connection).toBe('disconnected');
    act(() => {
      store.connect();
      lastWs().open();
      lastWs().emit({
        type: 'credentials',
        protocolVersion: PROTOCOL_VERSION,
        seat: 3,
        token: 'tok-hook',
      });
    });
    expect(result.current.connection).toBe('connected');
    expect(result.current.seat).toBe(3);
  });

  it('unsubscribe 后不再触发渲染', () => {
    const { store } = setup();
    const { result, unmount } = renderHook(() => useGameStore(store));
    unmount();
    act(() => {
      store.connect();
    });
    expect(result.current.connection).toBe('disconnected');
  });
});

/** 开房并入座：connect → open → credentials + room_state。 */
function enterRoom(store: GameStore, code = 'ABCD'): FakeWebSocket {
  store.connect();
  const ws = lastWs();
  ws.open();
  ws.emit({ type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat: 0, token: 'tok-A' });
  ws.emit({
    type: 'room_state',
    protocolVersion: PROTOCOL_VERSION,
    room: { ...roomFixture(), code },
    yourSeat: 0,
  });
  return ws;
}

describe('GameStore token 持久化与恢复', () => {
  it('credentials + room_state 后 token 按房间号持久化到 storage', () => {
    const { store, storage } = setup();
    enterRoom(store);
    expect(storage.getItem('brass:token:ABCD')).toBe('tok-A');
  });

  it('restoreSession 读到已存 token：connect 后自动 resume 抢回座位', () => {
    const storage = new FakeStorage();
    storage.setItem('brass:token:WXYZ23', 'tok-old');
    const { store } = setup(0, { storage });
    expect(store.restoreSession()).toBe(true);
    expect(store.getState().token).toBe('tok-old');
    store.connect();
    const ws = lastWs();
    ws.open();
    expect(ws.lastSent()).toEqual({
      type: 'resume',
      protocolVersion: PROTOCOL_VERSION,
      token: 'tok-old',
    });
  });

  it('无已存 token 时 restoreSession 返回 false，connect 后不自动发 resume', () => {
    const { store } = setup();
    expect(store.restoreSession()).toBe(false);
    store.connect();
    const ws = lastWs();
    ws.open();
    expect(ws.sent).toHaveLength(0);
  });

  it('resume 失败（invalid-token / session-lost）→ 清 token 与持久化、回大厅态', () => {
    const storage = new FakeStorage();
    storage.setItem('brass:token:WXYZ23', 'tok-dead');
    const { store } = setup(0, { storage });
    store.restoreSession();
    store.connect();
    const ws = lastWs();
    ws.open();
    ws.emit({
      type: 'error',
      protocolVersion: PROTOCOL_VERSION,
      code: 'session-lost',
      message: '对局已随服务器重启丢失（M2 不恢复进行中对局）',
    });
    const s = store.getState();
    expect(s.token).toBeNull();
    expect(s.room).toBeNull();
    expect(s.seat).toBeNull();
    expect(s.lastError?.code).toBe('session-lost');
    expect(storage.getItem('brass:token:WXYZ23')).toBeNull();
  });
});

describe('GameStore 双标签页接管', () => {
  it('本 tab 发 resume 时写 owner 标记（tabId + 时间戳）', () => {
    const storage = new FakeStorage();
    storage.setItem('brass:token:WXYZ23', 'tok-A');
    const { store } = setup(0, { storage, tabId: 'tab-A' });
    store.restoreSession();
    store.connect();
    lastWs().open();
    const marker = JSON.parse(storage.getItem('brass:owner:WXYZ23') ?? 'null') as {
      tabId: string;
      at: number;
    } | null;
    expect(marker?.tabId).toBe('tab-A');
    expect(typeof marker?.at).toBe('number');
  });

  it('被动 close 且 owner 标记为他 tab 新鲜值 → takenOver，停止自动重连', async () => {
    const storage = new FakeStorage();
    const { store } = setup(0, { storage, tabId: 'tab-A' });
    const ws = enterRoom(store);
    // 另一标签页用同 token resume：先写自己的 owner 标记，服务器随后踢掉本连接
    storage.setItem(
      'brass:owner:ABCD',
      JSON.stringify({ tabId: 'tab-B', at: Date.now() }),
    );
    ws.serverClose();
    await tick();
    const s = store.getState();
    expect(s.takenOver).toBe(true);
    expect(s.connection).toBe('disconnected');
    expect(FakeWebSocket.instances).toHaveLength(1); // 没有自动重连
  });

  it('reclaim 重新接管：重连并自动 resume，takenOver 解除', async () => {
    const storage = new FakeStorage();
    const { store } = setup(0, { storage, tabId: 'tab-A' });
    const ws = enterRoom(store);
    storage.setItem(
      'brass:owner:ABCD',
      JSON.stringify({ tabId: 'tab-B', at: Date.now() }),
    );
    ws.serverClose();
    await tick();
    expect(store.getState().takenOver).toBe(true);
    store.reclaim();
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws);
    ws2.open();
    expect(ws2.lastSent()).toEqual({
      type: 'resume',
      protocolVersion: PROTOCOL_VERSION,
      token: 'tok-A',
    });
    expect(store.getState().takenOver).toBe(false);
    // 重新接管后 owner 标记回到本 tab
    const marker = JSON.parse(storage.getItem('brass:owner:ABCD') ?? 'null') as {
      tabId: string;
    } | null;
    expect(marker?.tabId).toBe('tab-A');
  });

  it('owner 标记过期（他 tab 早已关闭）→ 视为普通断线，照常自动重连', async () => {
    const storage = new FakeStorage();
    const { store } = setup(0, { storage, tabId: 'tab-A' });
    const ws = enterRoom(store);
    storage.setItem(
      'brass:owner:ABCD',
      JSON.stringify({ tabId: 'tab-B', at: Date.now() - 60_000 }),
    );
    ws.serverClose();
    await tick();
    expect(store.getState().takenOver).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(2); // 已自动重连
  });
});

describe('GameStore leaveRoom（返回大厅）', () => {
  it('清空持久化 token/owner、重置状态、并以干净身份重连', () => {
    const storage = new FakeStorage();
    const { store } = setup(0, { storage, tabId: 'tab-A' });
    enterRoom(store);
    expect(storage.getItem('brass:token:ABCD')).toBe('tok-A');
    store.leaveRoom();
    expect(storage.getItem('brass:token:ABCD')).toBeNull();
    expect(storage.getItem('brass:owner:ABCD')).toBeNull();
    const s = store.getState();
    expect(s.token).toBeNull();
    expect(s.room).toBeNull();
    expect(s.seat).toBeNull();
    expect(s.snapshot).toBeNull();
    expect(s.gameOver).toBeNull();
    expect(s.takenOver).toBe(false);
    // 干净身份重连：新 ws，open 后不发 resume
    const ws = lastWs();
    ws.open();
    expect(ws.sent).toHaveLength(0);
    expect(store.getState().connection).toBe('connected');
  });
});
