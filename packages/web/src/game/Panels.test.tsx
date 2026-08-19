/**
 * 信息面板渲染测试（M2 Task 10 Step 2）：给 FilteredState fixture 断言关键数字。
 * fixture 由 engine newGame + protocol filterStateFor 生成，不手搓状态。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { newGame, tileDef } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import type { FilteredState, RoomState } from '@brass/protocol';
import type { Card } from '@brass/engine';
import {
  CoalIronMarket,
  HandBar,
  IncomeTrack,
  LogPanel,
  PlayerBoard,
  TurnOrderBar,
} from './Panels';
import type { LogEntry } from './store';

function freshState(): FilteredState {
  return filterStateFor(newGame(4, 42), 0);
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
    started: true,
  };
}

describe('<CoalIronMarket>', () => {
  it('渲染煤 14 格 / 铁 10 格需求轨，初始填充 13 煤 8 铁', () => {
    const { container } = render(<CoalIronMarket state={freshState()} />);
    const coalCells = container.querySelectorAll('[data-testid="coal-track"] .market-cell');
    const ironCells = container.querySelectorAll('[data-testid="iron-track"] .market-cell');
    expect(coalCells).toHaveLength(14);
    expect(ironCells).toHaveLength(10);
    expect(
      container.querySelectorAll('[data-testid="coal-track"] .market-cell.filled'),
    ).toHaveLength(13);
    expect(
      container.querySelectorAll('[data-testid="iron-track"] .market-cell.filled'),
    ).toHaveLength(8);
  });

  it('显示下一块买价（最便宜填充格）；空格在低价端', () => {
    const state = freshState();
    const { container } = render(<CoalIronMarket state={state} />);
    expect(screen.getByTestId('coal-next-price')).toHaveTextContent('£1');
    expect(screen.getByTestId('iron-next-price')).toHaveTextContent('£2');
    // 煤初始留 1 个 £1 空格：第一格空、第二格填
    const coalCells = container.querySelectorAll('[data-testid="coal-track"] .market-cell');
    expect(coalCells[0]?.classList.contains('filled')).toBe(false);
    expect(coalCells[1]?.classList.contains('filled')).toBe(true);
  });

  it('市场买空后显示兜底价（煤 £8 / 铁 £6）', () => {
    const state = freshState();
    state.coalMarket = 0;
    state.ironMarket = 0;
    render(<CoalIronMarket state={state} />);
    expect(screen.getByTestId('coal-next-price')).toHaveTextContent('£8');
    expect(screen.getByTestId('iron-next-price')).toHaveTextContent('£6');
  });
});

describe('<IncomeTrack>', () => {
  it('渲染各人收入等级 / 现金 / VP（初始：等级0、£17、0VP）', () => {
    render(<IncomeTrack state={freshState()} />);
    for (let i = 0; i < 4; i++) {
      const row = screen.getByTestId(`income-row-${i}`);
      expect(row).toHaveTextContent('等级0');
      expect(row).toHaveTextContent('£17');
      expect(row).toHaveTextContent('0VP');
    }
  });

  it('incomeSpace 换算为等级（space 15 → 等级 3）并显示昵称', () => {
    const state = freshState();
    const p1 = state.players[1];
    if (p1 === undefined) throw new Error('fixture 缺玩家 1');
    p1.incomeSpace = 15;
    p1.money = 30;
    p1.vp = 12;
    render(<IncomeTrack state={state} room={roomFixture()} />);
    const row = screen.getByTestId('income-row-1');
    expect(row).toHaveTextContent('乙');
    expect(row).toHaveTextContent('等级3');
    expect(row).toHaveTextContent('£30');
    expect(row).toHaveTextContent('12VP');
  });
});

describe('<PlayerBoard>', () => {
  it('显示收入等级/格位/现金/VP 与板块摘要；面板堆叠数量', () => {
    const state = freshState();
    const p0 = state.players[0];
    if (p0 === undefined) throw new Error('fixture 缺玩家 0');
    p0.incomeSpace = 15; // 等级 3（区间 13–14）
    p0.money = 30;
    p0.vp = 12;
    render(<PlayerBoard state={state} seat={0} room={roomFixture()} defaultOpen />);
    expect(screen.getByTestId('player-board-toggle-0')).toHaveTextContent('甲');
    expect(screen.getByTestId('player-board-toggle-0')).toHaveTextContent('收入等级 3');
    expect(screen.getByTestId('player-board-meta-0')).toHaveTextContent('收入格 15');
    expect(screen.getByTestId('player-board-meta-0')).toHaveTextContent('£30');
    expect(screen.getByTestId('player-board-meta-0')).toHaveTextContent('12VP');
    // 初始无已建板块 → 占位；面板堆叠按等级列出（合计 45 块：9+10+10+9+3+1+1+2）
    expect(screen.getByTestId('player-board-built-0')).toHaveTextContent('尚未建造');
    expect(screen.getByTestId('player-board-stack-0')).toHaveTextContent('Lv1 ×9');
    expect(screen.getByTestId('player-board-stack-0')).toHaveTextContent('Lv8 ×2');
  });

  it('已建板块按产业聚合显示等级/翻转/收入', () => {
    const state = freshState();
    // 给 0 号玩家造两个板块：birmingham 棉纺 Lv2（翻转），derby 煤矿 Lv1（未翻转）
    const coal = tileDef('coal', 1);
    const cotton = tileDef('cotton', 2);
    if (coal === undefined || cotton === undefined) throw new Error('缺 TileDef');
    state.board.slots['birmingham']![0] = {
      tile: cotton,
      player: 0,
      flipped: true,
      resources: 0,
    };
    state.board.slots['derby']![0] = {
      tile: coal,
      player: 0,
      flipped: false,
      resources: 2,
    };
    render(<PlayerBoard state={state} seat={0} defaultOpen />);
    const built = screen.getByTestId('player-board-built-0');
    expect(built).toHaveTextContent('棉纺');
    expect(built).toHaveTextContent('煤矿');
    expect(built).toHaveTextContent('Lv2');
    expect(built).toHaveTextContent('Lv1');
    // 棉纺板块是翻转态（✓），煤矿未翻转（·）
    const tile = screen.getByTestId('player-board-tile-0-cotton-0');
    expect(tile.classList.contains('flipped')).toBe(true);
  });

  it('默认折叠：不展开时无 meta；点击展开', () => {
    const state = freshState();
    render(<PlayerBoard state={state} seat={1} room={roomFixture()} defaultOpen={false} />);
    expect(screen.queryByTestId('player-board-meta-1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('player-board-toggle-1'));
    expect(screen.getByTestId('player-board-meta-1')).toBeInTheDocument();
  });
});

describe('<TurnOrderBar>', () => {
  it('按 turnOrder 渲染顺位，当前玩家高亮', () => {
    const state = freshState();
    const { container } = render(<TurnOrderBar state={state} />);
    const items = container.querySelectorAll('[data-testid="turn-order"] li');
    expect(items).toHaveLength(4);
    const current = state.turnOrder[state.currentPlayerIdx];
    items.forEach((li, i) => {
      const seat = state.turnOrder[i];
      expect(li.getAttribute('data-player')).toBe(String(seat));
      expect(li.classList.contains('current')).toBe(seat === current);
    });
  });

  it('显示各人本轮已花金额与昵称', () => {
    const state = freshState();
    const p0 = state.players[0];
    if (p0 === undefined) throw new Error('fixture 缺玩家 0');
    p0.spentThisRound = 5;
    render(<TurnOrderBar state={state} room={roomFixture()} />);
    const item = screen
      .getByTestId('turn-order')
      .querySelector('[data-player="0"]');
    expect(item).toHaveTextContent('甲');
    expect(item).toHaveTextContent('£5');
  });
});

describe('<HandBar>', () => {
  function handState(cards: Card[]): FilteredState {
    const state = freshState();
    const p0 = state.players[0];
    if (p0 === undefined) throw new Error('fixture 缺玩家 0');
    p0.hand = { kind: 'full', cards };
    return state;
  }

  it('自己手牌：location 卡显示城市名，industry 卡显示产业图标', () => {
    const state = handState([
      { id: 'l0', kind: 'location', location: 'birmingham' },
      { id: 'i0', kind: 'industry', industries: ['cotton', 'manufacturer'] },
    ]);
    render(<HandBar state={state} seat={0} />);
    const cardL = screen.getByTestId('hand-card-l0');
    expect(cardL).toHaveTextContent('Birmingham');
    const cardI = screen.getByTestId('hand-card-i0');
    expect(cardI).toHaveTextContent('C');
    expect(cardI).toHaveTextContent('M');
    expect(cardI.classList.contains('wild')).toBe(false);
  });

  it('wild 卡带角标', () => {
    const state = handState([
      { id: 'w0', kind: 'wild-location' },
      { id: 'w1', kind: 'wild-industry' },
    ]);
    render(<HandBar state={state} seat={0} />);
    expect(screen.getByTestId('hand-card-w0').classList.contains('wild')).toBe(true);
    expect(screen.getByTestId('hand-card-w1').classList.contains('wild')).toBe(true);
  });

  it('他人只显示牌数；点击自己手牌触发 onSelect', () => {
    const state = handState([{ id: 'l0', kind: 'location', location: 'derby' }]);
    const selected: string[] = [];
    render(<HandBar state={state} seat={0} onSelect={(id) => selected.push(id)} />);
    for (let i = 1; i < 4; i++) {
      expect(screen.getByTestId(`opponent-hand-${i}`)).toHaveTextContent('8 张');
    }
    screen.getByTestId('hand-card-l0').click();
    expect(selected).toEqual(['l0']);
  });

  it('selectedCard 加 selected 类', () => {
    const state = handState([{ id: 'l0', kind: 'location', location: 'derby' }]);
    render(<HandBar state={state} seat={0} selectedCard="l0" />);
    expect(screen.getByTestId('hand-card-l0').classList.contains('selected')).toBe(true);
  });
});

describe('<LogPanel>', () => {
  it('渲染 action_applied 流：seq、玩家、行动摘要', () => {
    const log: LogEntry[] = [
      { seq: 0, player: 1, action: { type: 'build', cardId: 'c', industry: 'coal', location: 'birmingham' }, events: [] },
      { seq: 1, player: 2, action: { type: 'loan', cardId: 'c2' }, events: [] },
      { seq: 2, player: 1, action: { type: 'scout', cardIds: ['a', 'b', 'c'] }, events: [] },
    ];
    render(<LogPanel log={log} room={roomFixture()} />);
    const entries = screen.getAllByTestId('log-entry');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent('#0');
    expect(entries[0]).toHaveTextContent('乙');
    expect(entries[0]).toHaveTextContent('建造 coal @ Birmingham');
    expect(entries[1]).toHaveTextContent('贷款');
    expect(entries[2]).toHaveTextContent('侦察');
  });

  it('空日志显示占位文本', () => {
    render(<LogPanel log={[]} />);
    expect(screen.getByTestId('log-empty')).toBeInTheDocument();
  });
});
