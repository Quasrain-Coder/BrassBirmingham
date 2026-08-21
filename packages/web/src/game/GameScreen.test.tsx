/**
 * GameScreen 接线测试（M2 Task 11 Step 2）：store 驱动 → 棋盘/手牌/行动栏联动。
 * FakeWebSocket 注入；snapshot 帧由 engine newGame + filterStateFor + enumerateActions 生成。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
    const { store, ws, game, seat } = setup(true);
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
    // 暂存同步:点选后上行一帧 draft_update(含播报文案)
    const lastDraft = JSON.parse(ws.sent[ws.sent.length - 1]!) as {
      type: string;
      draft: { text: string } | null;
    };
    expect(lastDraft.type).toBe('draft_update');
    expect(lastDraft.draft?.text).toContain('贷款');
    fireEvent.click(confirm);

    // 服务端接受后回快照(seq 推进)→ 清选牌,暂存清除帧收尾
    act(() => {
      ws.emit({
        type: 'snapshot',
        protocolVersion: PROTOCOL_VERSION,
        seq: 2,
        state: filterStateFor(game, seat),
        legalActions: [],
      });
    });
    // 确认后:submit_action 帧(提交的就是枚举项本身),随后一帧 draft_update 清除暂存
    const frames = ws.sent.map((s) => JSON.parse(s) as { type: string; token?: string; action?: Action });
    const frame = frames.filter((f) => f.type === 'submit_action').at(-1)!;
    expect(frame.token).toBe('tok');
    expect(frame.action).toEqual(loan);
    const lastFrame = frames[frames.length - 1]!;
    expect(lastFrame.type).toBe('draft_update'); // 暂存清除帧
    expect(store.getState().selectedCard).toBeNull(); // 快照推进后清选牌
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
    // 面板顶部两行:第一行顺位+名称+钱;第二行本回合行动+开销
    const rank1 = screen.getByTestId(`compact-rank-${game.turnOrder[0]!}`);
    expect(rank1).toHaveTextContent('#1');
    const round1 = screen.getByTestId(`compact-round-${game.turnOrder[0]!}`);
    expect(round1).toHaveTextContent('本回合未行动');
    // 再点一次回到经典布局
    fireEvent.click(screen.getByTestId('toggle-layout'));
    expect(container.querySelector('.wide-grid')).toBeNull();
    void ws;
  });

  it('播报串行:行动聚光灯播完(5s)后才播新一轮播报', () => {
    vi.useFakeTimers();
    try {
      const { store, ws, game, seat } = setup(true);
      render(<GameScreen store={store} />);
      // 一条行动 → 聚光灯出现
      act(() => {
        ws.emit({
          type: 'action_applied',
          protocolVersion: PROTOCOL_VERSION,
          seq: 1,
          player: seat,
          action: { type: 'loan', cardId: 'c0' },
          events: [],
        });
      });
      expect(screen.getByTestId('action-spotlight')).toHaveTextContent('贷款');
      // 同瞬间进入第 2 轮(快照 round=2)→ 轮次播报必须排队,不能与聚光灯同屏
      act(() => {
        ws.emit({
          type: 'snapshot',
          protocolVersion: PROTOCOL_VERSION,
          seq: 2,
          state: filterStateFor({ ...game, round: 2 }, seat),
          legalActions: [],
        });
      });
      expect(screen.queryByTestId('round-banner')).toBeNull();
      expect(screen.getByTestId('action-spotlight')).toBeInTheDocument();
      // 聚光灯播完 → 轮次播报上场
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByTestId('action-spotlight')).toBeNull();
      expect(screen.getByTestId('round-banner')).toHaveTextContent('第 2 轮');
      // 轮次播报同样播足 5 秒后消失
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByTestId('round-banner')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('他人暂存:不播报(仅幽灵落子);重置本回合全场播报', () => {
    vi.useFakeTimers();
    try {
      const { store, ws, game, seat } = setup(false); // 非本人回合:当前玩家是别人
      const otherSeat = game.turnOrder[game.currentPlayerIdx]!;
      expect(otherSeat).not.toBe(seat);
      render(<GameScreen store={store} />);

      // 他人暂存 → 不出现任何暂存播报(临时动作不播报,确认后才播)
      act(() => {
        ws.emit({
          type: 'player_draft',
          protocolVersion: PROTOCOL_VERSION,
          seat: otherSeat,
          draft: { links: [5], text: '建设连接 1 条（待定）' },
        });
      });
      expect(screen.queryByTestId('draft-spotlight')).toBeNull();
      expect(screen.queryByTestId('action-spotlight')).toBeNull();

      // 重置本回合 → 全场播报"已重置本回合"
      act(() => {
        ws.emit({ type: 'turn_reset', protocolVersion: PROTOCOL_VERSION, seat: otherSeat });
      });
      expect(screen.getByTestId('round-banner')).toHaveTextContent('已重置本回合');
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByTestId('round-banner')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('播报流:一帧内多条行动逐条入队,不丢中间播报', () => {
    vi.useFakeTimers();
    try {
      const { store, ws, game } = setup(true);
      render(<GameScreen store={store} />);
      const p0 = game.turnOrder[0]!;
      const p1 = game.turnOrder[1]!;
      // 同一帧内连发两条 action_applied(模拟 AI 连动)
      act(() => {
        ws.emit({
          type: 'action_applied',
          protocolVersion: PROTOCOL_VERSION,
          seq: 1,
          player: p0,
          action: { type: 'loan', cardId: 'c0' },
          events: [],
        });
        ws.emit({
          type: 'action_applied',
          protocolVersion: PROTOCOL_VERSION,
          seq: 2,
          player: p1,
          action: { type: 'pass', cardId: 'c1' },
          events: [],
        });
      });
      // 第一条立即播;第二条排队,5 秒后接棒
      expect(screen.getByTestId('action-spotlight')).toHaveTextContent('贷款');
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByTestId('action-spotlight')).toHaveTextContent('过');
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByTestId('action-spotlight')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
