/**
 * GameScreen 接线测试（M2 Task 11 Step 2）：store 驱动 → 棋盘/手牌/行动栏联动。
 * FakeWebSocket 注入；snapshot 帧由 engine newGame + filterStateFor + enumerateActions 生成。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@brass/protocol';
import type { ServerMessage } from '@brass/protocol';
import { enumerateActions, newGame } from '@brass/engine';
import type { Action } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import { GameClient, GameStore } from './store';
import type { WebSocketLike } from './store';
import { GameScreen } from './GameScreen';

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
}

function setup(asCurrentPlayer: boolean) {
  const game = newGame(4, 42);
  const current = game.turnOrder[game.currentPlayerIdx]!;
  const seat = asCurrentPlayer ? current : ((current + 1) % 4);
  const client = new GameClient('ws://test', (url) => new FakeWebSocket(url));
  const store = new GameStore(client, { reconnectDelayMs: 0 });
  store.connect();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  act(() => {
    ws.open();
    ws.emit({ type: 'credentials', protocolVersion: PROTOCOL_VERSION, seat, token: 'tok' });
    ws.emit({
      type: 'snapshot',
      protocolVersion: PROTOCOL_VERSION,
      seq: 1,
      state: filterStateFor(game, seat),
      legalActions: seat === current ? enumerateActions(game, seat) : [],
    });
  });
  return { store, ws, game, seat };
}

describe('<GameScreen>', () => {
  it('无快照：显示等待提示', () => {
    const client = new GameClient('ws://test', (url) => new FakeWebSocket(url));
    const store = new GameStore(client);
    render(<GameScreen store={store} />);
    expect(screen.getByTestId('no-snapshot')).toHaveTextContent('等待对局快照');
  });

  it('本人回合：选牌 → 棋盘高亮；贷款 → 确认提交 submit_action 帧', () => {
    const { store, ws, seat } = setup(true);
    const { container } = render(<GameScreen store={store} />);
    expect(screen.getByTestId('select-card-hint')).toBeInTheDocument();

    // 选一张有 loan 行动的牌（每张牌都有）
    const legal = store.getState().legalActions;
    const loan = legal.find((a): a is Action => a.type === 'loan');
    if (loan === undefined || loan.type !== 'loan') throw new Error('缺 loan 行动');
    fireEvent.click(screen.getByTestId(`hand-card-${loan.cardId}`));
    expect(store.getState().selectedCard).toBe(loan.cardId);
    // 选牌后棋盘出现高亮目标（build 槽位或 network 边）
    expect(container.querySelectorAll('.highlighted').length).toBeGreaterThan(0);

    // 点贷款 → 确认钮带上描述 → 确认提交
    fireEvent.click(screen.getByTestId('quick-loan'));
    const confirm = screen.getByTestId('confirm-action');
    expect(confirm).toBeEnabled();
    expect(confirm).toHaveTextContent('贷款');
    fireEvent.click(confirm);

    const frame = JSON.parse(ws.sent[ws.sent.length - 1]!) as {
      type: string;
      token: string;
      action: Action;
    };
    expect(frame.type).toBe('submit_action');
    expect(frame.token).toBe('tok');
    expect(frame.action).toEqual(loan); // 提交的就是枚举项本身
    expect(store.getState().selectedCard).toBeNull(); // 提交后清选牌
    expect(seat).toBe(store.getState().seat);
  });

  it('非本人回合：只读——显示"等待 X 行动"，无高亮、选牌无效', () => {
    const { store } = setup(false);
    const { container } = render(<GameScreen store={store} />);
    expect(screen.getByTestId('waiting')).toHaveTextContent('等待');
    expect(container.querySelectorAll('.highlighted')).toHaveLength(0);
    // 手牌点击不生效（onSelect 未传）
    const anyCard = container.querySelector('.hand-card') as Element;
    fireEvent.click(anyCard);
    expect(store.getState().selectedCard).toBeNull();
  });

  it('宽屏布局:切换按钮 → 左右两列面板铺开 + 本回合信息行', () => {
    const { store, game, ws } = setup(true);
    const { container } = render(<GameScreen store={store} />);
    expect(container.querySelector('.wide-grid')).toBeNull();
    fireEvent.click(screen.getByTestId('toggle-layout'));
    const grid = container.querySelector('.wide-grid');
    expect(grid).not.toBeNull();
    // 4p:左列 2 个席位、右列 2 个席位,面板全部铺开(defaultOpen)
    expect(container.querySelectorAll('.wide-col-left .wide-seat')).toHaveLength(2);
    expect(container.querySelectorAll('.wide-col-right .wide-seat')).toHaveLength(2);
    // 本回合信息行:顺位徽标 + 本回合行动 + 开销(钱数总额在面板头部,不重复)
    const info0 = screen.getByTestId(`round-info-${game.turnOrder[0]!}`);
    expect(info0).toHaveTextContent('#1');
    expect(info0).toHaveTextContent('本回合未行动');
    expect(info0).toHaveTextContent('开销 £0');
    // 再点一次回到经典布局
    fireEvent.click(screen.getByTestId('toggle-layout'));
    expect(container.querySelector('.wide-grid')).toBeNull();
    void ws;
  });

  it('离开对局：点按钮 → 发 leave 帧并回到大厅态', () => {
    const { store, ws } = setup(true);
    render(<GameScreen store={store} />);
    const leave = screen.getByTestId('leave-game');
    expect(leave).toBeInTheDocument();
    fireEvent.click(leave);
    const frame = JSON.parse(ws.sent[ws.sent.length - 1]!) as { type: string; token: string };
    expect(frame.type).toBe('leave');
    expect(frame.token).toBe('tok');
    // 会话清空：回大厅（token 空、snapshot 空）
    expect(store.getState().token).toBeNull();
    expect(store.getState().snapshot).toBeNull();
    expect(store.getState().room).toBeNull();
  });
});
