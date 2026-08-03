/**
 * Lobby / RoomView 组件测试（M2 Task 12 Step 1）。
 * FakeWebSocket 注入驱动 store；表单提交 → 上行帧校验；房间视图 → 座位/开始按钮状态。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@brass/protocol';
import type { RoomState, ServerMessage } from '@brass/protocol';
import { GameClient, GameStore } from '../game/store';
import type { WebSocketLike } from '../game/store';
import { Lobby, RoomView } from './Lobby';

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
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  lastSent(): unknown {
    const raw = this.sent[this.sent.length - 1];
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

function setup(): { store: GameStore; ws: FakeWebSocket } {
  FakeWebSocket.instances = [];
  const client = new GameClient('ws://test/ws', (url) => new FakeWebSocket(url));
  const store = new GameStore(client, { reconnectDelayMs: 0 });
  store.connect();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (ws === undefined) throw new Error('尚未创建任何 FakeWebSocket');
  return { store, ws };
}

function fullRoom(overrides: Partial<RoomState> = {}): RoomState {
  return {
    code: 'ABCD23',
    config: { playerCount: 4 },
    customSeed: false,
    seats: [
      { seat: 0, nickname: '甲', isAI: false, connected: true },
      { seat: 1, nickname: '乙', isAI: false, connected: false },
      { seat: 2, nickname: '丙', isAI: false, connected: true },
      { seat: 3, nickname: '丁', isAI: false, connected: true },
    ],
    started: false,
    ...overrides,
  };
}

/** 入座：credentials + room_state（本人 seat 0，token tok-me）。 */
function enterRoom(
  ws: FakeWebSocket,
  room: RoomState,
  yourSeat = 0 as number,
): void {
  act(() => {
    ws.emit({ type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat: yourSeat, token: 'tok-me' });
    ws.emit({ type: 'room_state', protocolVersion: PROTOCOL_VERSION, room, yourSeat });
  });
}

describe('<Lobby> 创建/加入表单', () => {
  it('渲染创建与加入两个表单', () => {
    const { store } = setup();
    render(<Lobby store={store} />);
    expect(screen.getByRole('heading', { name: 'Brass: Birmingham' })).toBeInTheDocument();
    expect(screen.getByTestId('create-form')).toBeInTheDocument();
    expect(screen.getByTestId('join-form')).toBeInTheDocument();
  });

  it('未连接时提交按钮不可用，连接后可用', () => {
    const { store, ws } = setup();
    render(<Lobby store={store} />);
    // 先填好表单，让"连接状态"成为唯一门控条件
    fireEvent.change(screen.getByTestId('create-nickname'), { target: { value: '甲' } });
    fireEvent.change(screen.getByTestId('join-nickname'), { target: { value: '乙' } });
    fireEvent.change(screen.getByTestId('join-code'), { target: { value: 'AB23CD' } });
    expect(screen.getByTestId('connection-status')).toHaveTextContent('正在连接');
    expect(screen.getByTestId('create-submit')).toBeDisabled();
    expect(screen.getByTestId('join-submit')).toBeDisabled();
    act(() => ws.open());
    expect(screen.getByTestId('connection-status')).toHaveTextContent('已连接');
    expect(screen.getByTestId('create-submit')).toBeEnabled();
    expect(screen.getByTestId('join-submit')).toBeEnabled();
  });

  it('创建房间：昵称 + 人数 + 种子 → create_room 帧', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    render(<Lobby store={store} />);
    fireEvent.change(screen.getByTestId('create-nickname'), { target: { value: ' 甲 ' } });
    fireEvent.change(screen.getByTestId('create-player-count'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('create-seed'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('create-submit'));
    expect(ws.lastSent()).toEqual({
      type: 'create_room',
      protocolVersion: PROTOCOL_VERSION,
      nickname: '甲',
      config: { playerCount: 3, seed: 7 },
    });
  });

  it('创建房间：种子留空或非法时不带 seed 字段，默认 4 人', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    render(<Lobby store={store} />);
    fireEvent.change(screen.getByTestId('create-nickname'), { target: { value: '甲' } });
    fireEvent.change(screen.getByTestId('create-seed'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('create-submit'));
    expect(ws.lastSent()).toEqual({
      type: 'create_room',
      protocolVersion: PROTOCOL_VERSION,
      nickname: '甲',
      config: { playerCount: 4 },
    });
  });

  it('加入房间：房间号转大写 → join_room 帧', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    render(<Lobby store={store} />);
    fireEvent.change(screen.getByTestId('join-nickname'), { target: { value: '乙' } });
    fireEvent.change(screen.getByTestId('join-code'), { target: { value: ' ab23cd ' } });
    fireEvent.click(screen.getByTestId('join-submit'));
    expect(ws.lastSent()).toEqual({
      type: 'join_room',
      protocolVersion: PROTOCOL_VERSION,
      code: 'AB23CD',
      nickname: '乙',
    });
  });

  it('昵称为空时创建/加入按钮不可用', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    render(<Lobby store={store} />);
    expect(screen.getByTestId('create-submit')).toBeDisabled();
    expect(screen.getByTestId('join-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('create-nickname'), { target: { value: '甲' } });
    expect(screen.getByTestId('create-submit')).toBeEnabled();
    expect(screen.getByTestId('join-submit')).toBeDisabled();
  });

  it('服务器错误（如 room-not-found）显示在页面上', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    render(<Lobby store={store} />);
    act(() => {
      ws.emit({
        type: 'error',
        protocolVersion: PROTOCOL_VERSION,
        code: 'room-not-found',
        message: '房间不存在: ZZZZ99',
      });
    });
    expect(screen.getByTestId('last-error')).toHaveTextContent('房间不存在');
  });
});

describe('<RoomView> 房间等待视图', () => {
  it('显示房间号、座位列表（含在线状态与"我"标记）、就位计数', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    enterRoom(ws, fullRoom());
    render(<RoomView store={store} />);
    expect(screen.getByTestId('room-code')).toHaveTextContent('ABCD23');
    expect(screen.getByTestId('seat-count')).toHaveTextContent('4/4');
    expect(screen.getByTestId('seat-0')).toHaveTextContent('甲');
    expect(screen.getByTestId('seat-0')).toHaveTextContent('（我）');
    expect(screen.getByTestId('seat-0')).toHaveTextContent('在线');
    expect(screen.getByTestId('seat-1')).toHaveTextContent('乙');
    expect(screen.getByTestId('seat-1')).toHaveTextContent('离线');
    expect(screen.getByTestId('seat-1')).not.toHaveTextContent('（我）');
  });

  it('customSeed 为 true 时显示"房主指定了种子"标记', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    enterRoom(ws, fullRoom({ customSeed: true }));
    render(<RoomView store={store} />);
    expect(screen.getByTestId('custom-seed-badge')).toHaveTextContent('房主指定了种子');
  });

  it('customSeed 为 false 时不显示种子标记', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    enterRoom(ws, fullRoom());
    render(<RoomView store={store} />);
    expect(screen.queryByTestId('custom-seed-badge')).not.toBeInTheDocument();
  });

  it('未满员：空位显示、开始按钮不可用', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    const partial = fullRoom({
      config: { playerCount: 3 },
      seats: [
        { seat: 0, nickname: '甲', isAI: false, connected: true },
        { seat: 1, nickname: '乙', isAI: false, connected: true },
        null,
      ],
    });
    enterRoom(ws, partial);
    render(<RoomView store={store} />);
    expect(screen.getByTestId('seat-count')).toHaveTextContent('2/3');
    expect(screen.getByTestId('seat-2')).toHaveTextContent('空位');
    expect(screen.getByTestId('start-game')).toBeDisabled();
  });

  it('满员：开始按钮可用，点击发 start_game（任意座位可点）', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    enterRoom(ws, fullRoom(), 2); // 本人坐 2 号位也能开始
    render(<RoomView store={store} />);
    const start = screen.getByTestId('start-game');
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(ws.lastSent()).toEqual({
      type: 'start_game',
      protocolVersion: PROTOCOL_VERSION,
      token: 'tok-me',
    });
  });

  it('满员但断线：开始按钮不可用（连接状态门控）', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    enterRoom(ws, fullRoom());
    render(<RoomView store={store} />);
    expect(screen.getByTestId('start-game')).toBeEnabled();
    act(() => {
      ws.onclose?.();
    });
    expect(store.getState().connection).toBe('disconnected');
    expect(screen.getByTestId('start-game')).toBeDisabled();
  });

  it('离开房间 → store 重置回大厅态', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    enterRoom(ws, fullRoom());
    render(<RoomView store={store} />);
    fireEvent.click(screen.getByTestId('leave-room'));
    expect(store.getState().room).toBeNull();
    expect(store.getState().token).toBeNull();
  });
});
