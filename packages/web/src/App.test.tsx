/**
 * App 路由测试（M2 Task 12 Step 2）：条件渲染 大厅 ↔ 房间等待 ↔ 对局 ↔ 终局，
 * 外加"连接被另一标签页接管"画面与刷新自动 resume。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@brass/protocol';
import type { RoomState, ServerMessage } from '@brass/protocol';
import { enumerateActions, newGame } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import { GameClient, GameStore } from './game/store';
import type { WebSocketLike } from './game/store';
import { App } from './App';

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

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  lastSent(): unknown {
    const raw = this.sent[this.sent.length - 1];
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

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

function setup(opts: { storage?: FakeStorage; tabId?: string } = {}): {
  store: GameStore;
  storage: FakeStorage;
} {
  FakeWebSocket.instances = [];
  const storage = opts.storage ?? new FakeStorage();
  const client = new GameClient('ws://test/ws', (url) => new FakeWebSocket(url));
  const store = new GameStore(client, {
    reconnectDelayMs: 0,
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

function roomFixture(overrides: Partial<RoomState> = {}): RoomState {
  return {
    code: 'ABCD23',
    config: { playerCount: 4 },
    customSeed: false,
    seats: [
      { seat: 0, nickname: '甲', isAI: false, connected: true },
      { seat: 1, nickname: '乙', isAI: false, connected: true },
      { seat: 2, nickname: '丙', isAI: false, connected: true },
      { seat: 3, nickname: '丁', isAI: false, connected: true },
    ],
    started: false,
    ...overrides,
  };
}

/** 渲染 App（useEffect 自动 connect）→ open → 入座（credentials + room_state）。 */
function renderInRoom(store: GameStore): FakeWebSocket {
  render(<App store={store} />);
  const ws = lastWs();
  act(() => {
    ws.open();
    ws.emit({ type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat: 0, token: 'tok-me' });
    ws.emit({
      type: 'room_state',
      protocolVersion: PROTOCOL_VERSION,
      room: roomFixture(),
      yourSeat: 0,
    });
  });
  return ws;
}

describe('<App> 路由', () => {
  it('无房间：显示大厅（创建/加入表单）', () => {
    const { store } = setup();
    render(<App store={store} />);
    expect(screen.getByTestId('create-form')).toBeInTheDocument();
    expect(screen.getByTestId('join-form')).toBeInTheDocument();
  });

  it('有房间无快照：显示房间等待视图（房间号 + 座位列表）', () => {
    const { store } = setup();
    renderInRoom(store);
    expect(screen.getByTestId('room-code')).toHaveTextContent('ABCD23');
    expect(screen.getByTestId('seat-0')).toHaveTextContent('甲');
  });

  it('有快照：进入对局画面', () => {
    const { store } = setup();
    const ws = renderInRoom(store);
    act(() => {
      const game = newGame(4, 42);
      const current = game.turnOrder[game.currentPlayerIdx];
      if (current === undefined) throw new Error('unreachable');
      ws.emit({
        type: 'snapshot',
        protocolVersion: PROTOCOL_VERSION,
        seq: 1,
        state: filterStateFor(game, 0),
        legalActions: current === 0 ? enumerateActions(game, 0) : [],
      });
    });
    expect(document.querySelector('.game-screen')).not.toBeNull();
    expect(screen.queryByTestId('create-form')).not.toBeInTheDocument();
  });

  it('终局：显示胜者与各座位分数；返回大厅清空 token 并回到大厅', () => {
    const { store, storage } = setup();
    const ws = renderInRoom(store);
    expect(storage.getItem('brass:token:ABCD23')).toBe('tok-me');
    act(() => {
      ws.emit({
        type: 'game_over',
        protocolVersion: PROTOCOL_VERSION,
        winner: [1],
        finalScores: [80, 95, 70, 60],
      });
    });
    expect(screen.getByRole('heading', { name: '对局结束' })).toBeInTheDocument();
    expect(screen.getByTestId('winner')).toHaveTextContent('乙');
    expect(screen.getByTestId('final-scores')).toHaveTextContent('甲：80');
    expect(screen.getByTestId('final-scores')).toHaveTextContent('丁：60');
    fireEvent.click(screen.getByTestId('back-lobby'));
    expect(screen.getByTestId('create-form')).toBeInTheDocument();
    expect(storage.getItem('brass:token:ABCD23')).toBeNull();
    expect(store.getState().gameOver).toBeNull();
  });

  it('连接被另一标签页接管：显示提示而非静默；重新接管后发 resume', async () => {
    const storage = new FakeStorage();
    const { store } = setup({ storage, tabId: 'tab-A' });
    const ws = renderInRoom(store);
    // 另一标签页用同 token resume：先写自己的 owner 标记，服务器随后踢掉本连接
    storage.setItem(
      'brass:owner:ABCD23',
      JSON.stringify({ tabId: 'tab-B', at: Date.now() }),
    );
    act(() => ws.serverClose());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId('taken-over')).toHaveTextContent('连接被另一标签页接管');
    expect(FakeWebSocket.instances).toHaveLength(1); // 未自动重连互踢
    fireEvent.click(screen.getByTestId('reclaim'));
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws);
    act(() => ws2.open());
    expect(ws2.lastSent()).toEqual({
      type: 'resume',
      protocolVersion: PROTOCOL_VERSION,
      token: 'tok-me',
    });
  });

  it('刷新恢复：storage 有 token 时渲染即自动 connect + resume', () => {
    const storage = new FakeStorage();
    storage.setItem('brass:token:WXYZ99', 'tok-saved');
    const { store } = setup({ storage });
    render(<App store={store} />);
    const ws = lastWs();
    act(() => ws.open());
    expect(ws.lastSent()).toEqual({
      type: 'resume',
      protocolVersion: PROTOCOL_VERSION,
      token: 'tok-saved',
    });
  });
});
