/**
 * M3 Task 5：web 集成——AI 座位配置与理由展示（失败测试先行）。
 *
 * 覆盖：
 * - Lobby 创建表单：AI 座位数（0..playerCount-1）+ 难度（简单/普通/困难），
 *   count>0 时 create_room 帧带 aiSeats；count=0 时不带；人数变化时 AI 数 clamp。
 * - RoomView 座位列表：AI 徽章 + 难度标签（真人无徽章，AI 不显在线状态）。
 * - store：ai_thinking 消息驱动 thinkingSeats 状态迁移（true 加入/幂等、false 移除，
 *   leaveRoom 清空）；action_applied 的 reason/degraded 进 LogEntry。
 * - LogPanel：带 reason 的条目渲染引用块；degraded 条目带"（已降级）"标记。
 * - TurnOrderBar / AIIndicator：ai_thinking 座位高亮"思考中…"。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { newGame } from '@brass/engine';
import { PROTOCOL_VERSION, filterStateFor } from '@brass/protocol';
import type { RoomState, ServerMessage } from '@brass/protocol';
import { GameClient, GameStore } from './store';
import type { LogEntry, WebSocketLike } from './store';
import { Lobby, RoomView } from '../lobby/Lobby';
import { LogPanel, TurnOrderBar } from './Panels';
import { AIIndicator } from './AIIndicator';

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

/** 连上并渲染 Lobby，填好昵称（创建按钮可用的最小条件）。 */
function renderConnectedLobby(): { store: GameStore; ws: FakeWebSocket } {
  const { store, ws } = setup();
  act(() => ws.open());
  render(<Lobby store={store} />);
  fireEvent.change(screen.getByTestId('create-nickname'), { target: { value: '甲' } });
  return { store, ws };
}

function aiRoom(): RoomState {
  return {
    code: 'ABCD23',
    config: { playerCount: 4, aiSeats: { count: 2, difficulty: 'hard' } },
    customSeed: false,
    seats: [
      { seat: 0, nickname: '甲', isAI: false, connected: true },
      { seat: 1, nickname: '乙', isAI: false, connected: false },
      { seat: 2, nickname: 'AI-1（困难）', isAI: true, connected: true },
      { seat: 3, nickname: 'AI-2（困难）', isAI: true, connected: true },
    ],
    started: false,
  };
}

describe('<Lobby> AI 座位配置', () => {
  it('AI 座位数选项范围 0..playerCount-1（默认 0）；count>0 时才显难度选择', () => {
    renderConnectedLobby();
    // 默认 4 人 → AI 数可选 0..3
    const countSelect = screen.getByTestId('create-ai-count') as HTMLSelectElement;
    expect([...countSelect.options].map((o) => o.value)).toEqual(['0', '1', '2', '3']);
    expect(countSelect.value).toBe('0');
    expect(screen.queryByTestId('create-ai-difficulty')).not.toBeInTheDocument();
    // 切到 2 人 → AI 数只能 0..1
    fireEvent.change(screen.getByTestId('create-player-count'), { target: { value: '2' } });
    expect([...countSelect.options].map((o) => o.value)).toEqual(['0', '1']);
    // 选 1 个 AI → 难度选择出现，默认普通
    fireEvent.change(countSelect, { target: { value: '1' } });
    const diffSelect = screen.getByTestId('create-ai-difficulty') as HTMLSelectElement;
    expect(diffSelect.value).toBe('normal');
    expect([...diffSelect.options].map((o) => o.textContent)).toEqual([
      '简单',
      '普通',
      '困难',
    ]);
  });

  it('人数调小时已选 AI 数 clamp 到 playerCount-1', () => {
    renderConnectedLobby();
    fireEvent.change(screen.getByTestId('create-ai-count'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('create-player-count'), { target: { value: '2' } });
    const countSelect = screen.getByTestId('create-ai-count') as HTMLSelectElement;
    expect(countSelect.value).toBe('1');
  });

  it('选 AI 座位 + 难度 → create_room 帧带 aiSeats', () => {
    const { ws } = renderConnectedLobby();
    fireEvent.change(screen.getByTestId('create-player-count'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('create-ai-count'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('create-ai-difficulty'), { target: { value: 'hard' } });
    fireEvent.click(screen.getByTestId('create-submit'));
    expect(ws.lastSent()).toEqual({
      type: 'create_room',
      protocolVersion: PROTOCOL_VERSION,
      nickname: '甲',
      config: { playerCount: 3, seed: expect.any(Number), aiSeats: { count: 1, difficulty: 'hard' } },
    });
  });

  it('AI 座位数为 0（默认）→ create_room 帧不带 aiSeats', () => {
    const { ws } = renderConnectedLobby();
    fireEvent.click(screen.getByTestId('create-submit'));
    expect(ws.lastSent()).toEqual({
      type: 'create_room',
      protocolVersion: PROTOCOL_VERSION,
      nickname: '甲',
      config: { playerCount: 4, seed: expect.any(Number) },
    });
  });
});

describe('<RoomView> AI 徽章', () => {
  it('AI 座位显示 AI 徽章与难度标签，不显在线状态；真人不变', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    act(() => {
      ws.emit({
        type: 'credentials',
        protocolVersion: PROTOCOL_VERSION,
        seat: 0,
        token: 'tok-me',
      });
      ws.emit({ type: 'room_state', protocolVersion: PROTOCOL_VERSION, room: aiRoom(), yourSeat: 0 });
    });
    render(<RoomView store={store} />);
    const aiSeat = screen.getByTestId('seat-2');
    expect(aiSeat).toHaveTextContent('AI-1（困难）');
    expect(screen.getByTestId('seat-2-ai-badge')).toHaveTextContent('AI');
    expect(aiSeat).not.toHaveTextContent('在线');
    // 真人座位无徽章、在线状态照常
    expect(screen.queryByTestId('seat-0-ai-badge')).not.toBeInTheDocument();
    expect(screen.getByTestId('seat-0')).toHaveTextContent('在线');
  });
});

describe('store：ai_thinking 与 reason', () => {
  it('ai_thinking(true) 加入 thinkingSeats（幂等），false 移除', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    const think = (seat: number, thinking: boolean): ServerMessage => ({
      type: 'ai_thinking',
      protocolVersion: PROTOCOL_VERSION,
      seat: seat as 0 | 1 | 2 | 3,
      thinking,
    });
    act(() => ws.emit(think(2, true)));
    expect(store.getState().thinkingSeats).toEqual([2]);
    // 重复 true 幂等（不重复入列）
    act(() => ws.emit(think(2, true)));
    expect(store.getState().thinkingSeats).toEqual([2]);
    act(() => ws.emit(think(3, true)));
    expect(store.getState().thinkingSeats).toEqual([2, 3]);
    act(() => ws.emit(think(2, false)));
    expect(store.getState().thinkingSeats).toEqual([3]);
    // 对不在列的座位发 false 为空操作
    act(() => ws.emit(think(0, false)));
    expect(store.getState().thinkingSeats).toEqual([3]);
  });

  it('leaveRoom 清空 thinkingSeats', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    act(() => {
      ws.emit({
        type: 'ai_thinking',
        protocolVersion: PROTOCOL_VERSION,
        seat: 2,
        thinking: true,
      });
    });
    expect(store.getState().thinkingSeats).toEqual([2]);
    act(() => store.leaveRoom());
    expect(store.getState().thinkingSeats).toEqual([]);
  });

  it('action_applied 的 reason/degraded 进 LogEntry；真人行动不带', () => {
    const { store, ws } = setup();
    act(() => ws.open());
    act(() => {
      ws.emit({
        type: 'action_applied',
        protocolVersion: PROTOCOL_VERSION,
        seq: 0,
        player: 2,
        action: { type: 'loan', cardId: 'c0' },
        events: [],
        reason: '现金见底，先贷款保运转',
        degraded: true,
      });
      ws.emit({
        type: 'action_applied',
        protocolVersion: PROTOCOL_VERSION,
        seq: 1,
        player: 0,
        action: { type: 'pass', cardId: 'c1' },
        events: [],
      });
    });
    const [aiEntry, humanEntry] = store.getState().log;
    expect(aiEntry?.reason).toBe('现金见底，先贷款保运转');
    expect(aiEntry?.degraded).toBe(true);
    expect(humanEntry?.reason).toBeUndefined();
    expect(humanEntry?.degraded).toBeUndefined();
  });
});

describe('<LogPanel> 理由与降级标记', () => {
  const room: RoomState = {
    code: 'ABCD',
    config: { playerCount: 4, aiSeats: { count: 1, difficulty: 'normal' } },
    customSeed: false,
    seats: [
      { seat: 0, nickname: '甲', isAI: false, connected: true },
      { seat: 1, nickname: '乙', isAI: false, connected: true },
      { seat: 2, nickname: 'AI-1（普通）', isAI: true, connected: true },
      { seat: 3, nickname: '丙', isAI: false, connected: true },
    ],
    started: true,
  };

  it('带 reason 的条目渲染引用块；degraded 条目带"（已降级）"标记', () => {
    const log: LogEntry[] = [
      {
        seq: 0,
        player: 2,
        action: { type: 'loan', cardId: 'c0' },
        events: [],
        reason: '现金见底，先贷款保运转',
        degraded: true,
      },
      { seq: 1, player: 0, action: { type: 'pass', cardId: 'c1' }, events: [] },
    ];
    render(<LogPanel log={log} room={room} />);
    const entries = screen.getAllByTestId('log-entry');
    const quote = entries[0]?.querySelector('blockquote');
    expect(quote).toHaveTextContent('现金见底，先贷款保运转');
    expect(entries[0]).toHaveTextContent('（已降级）');
    // 真人条目无引用块、无降级标记
    expect(entries[1]?.querySelector('blockquote')).toBeNull();
    expect(entries[1]).not.toHaveTextContent('（已降级）');
  });
});

describe('AI 思考中指示', () => {
  it('<TurnOrderBar> thinking 座位高亮并显示"思考中…"', () => {
    const state = filterStateFor(newGame(4, 42), 0);
    const { container } = render(
      <TurnOrderBar state={state} room={aiRoom()} thinkingSeats={[2]} />,
    );
    const thinking = container.querySelector('[data-player="2"]');
    expect(thinking?.classList.contains('thinking')).toBe(true);
    expect(thinking).toHaveTextContent('思考中…');
    const idle = container.querySelector('[data-player="0"]');
    expect(idle?.classList.contains('thinking')).toBe(false);
    expect(idle).not.toHaveTextContent('思考中…');
  });

  it('<AIIndicator> 列出正在思考的 AI 座位；空列表不渲染', () => {
    const { rerender } = render(<AIIndicator room={aiRoom()} thinkingSeats={[2, 3]} />);
    const indicator = screen.getByTestId('ai-thinking');
    expect(indicator).toHaveTextContent('AI-1（困难）');
    expect(indicator).toHaveTextContent('AI-2（困难）');
    expect(indicator).toHaveTextContent('思考中');
    rerender(<AIIndicator room={aiRoom()} thinkingSeats={[]} />);
    expect(screen.queryByTestId('ai-thinking')).not.toBeInTheDocument();
  });
});
