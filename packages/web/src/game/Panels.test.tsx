/**
 * 信息面板渲染测试：给 FilteredState fixture 断言关键数字与素材路径。
 * fixture 由 engine newGame + protocol filterStateFor 生成，不手搓状态。
 * （煤/铁市场格与收入轨已移至 BoardSvg，见其测试。）
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { newGame, tileDef } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import type { FilteredState, RoomState } from '@brass/protocol';
import type { Card } from '@brass/engine';
import { HandBar, LogPanel, PlayerBoard, TurnOrderBar, cardImageSrc } from './Panels';
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

describe('<PlayerBoard>', () => {
  it('显示收入等级/格位/现金/VP 与面板堆叠（按产业分组）', () => {
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
    expect(screen.getByTestId('player-board-meta-0')).toHaveTextContent('12 分');
    expect(screen.getByTestId('player-board-built-0')).toHaveTextContent('尚未建造');
    // 堆叠默认版图视图,切到明细再断言列表内容
    fireEvent.click(screen.getByTestId('stack-view-list-0'));
    // 堆叠按原版玩家板：每产业每级缩略图 + 剩余数 + 翻面得分/收入
    const stack = screen.getByTestId('player-board-stack-0');
    expect(stack).toHaveTextContent('棉纺厂');
    expect(stack).toHaveTextContent('制造厂');
    // 陶器厂 Lv5：剩 1 块，翻面 20 分 +5 收（engine TILES 数值）
    const pot5 = screen.getByTestId('player-board-stack-0-pottery-5');
    expect(pot5).toHaveTextContent('×1');
    expect(pot5).toHaveTextContent('翻 20分 +5收');
    expect(pot5.querySelector('img')?.getAttribute('src')).toBe('/assets/tiles/pottery-5-purple.png');
    // 制造厂 Lv8：2 块
    expect(screen.getByTestId('player-board-stack-0-manufacturer-8')).toHaveTextContent('×2');
  });

  it('板块建造后堆叠剩余数减少', () => {
    const state = freshState();
    const p0 = state.players[0];
    if (p0 === undefined) throw new Error('fixture 缺玩家 0');
    const before = p0.tiles.filter((t) => t.industry === 'cotton' && t.level === 1).length;
    p0.tiles = p0.tiles.filter((t) => !(t.industry === 'cotton' && t.level === 1));
    render(<PlayerBoard state={state} seat={0} defaultOpen />);
    fireEvent.click(screen.getByTestId('stack-view-list-0'));
    const tile = screen.getByTestId('player-board-stack-0-cotton-1');
    expect(before).toBe(3);
    expect(tile).toHaveTextContent('×0');
    expect(tile.classList.contains('exhausted')).toBe(true);
  });

  it('堆叠默认版图视图:mat 底图 + 栈顶描边/耗尽遮罩,可切换明细', () => {
    const state = freshState();
    const p0 = state.players[0];
    if (p0 === undefined) throw new Error('fixture 缺玩家 0');
    // 棉 I 全部移除 → 棉 I 框遮罩,棉 II 成栈顶描边
    p0.tiles = p0.tiles.filter((t) => !(t.industry === 'cotton' && t.level === 1));
    const { container } = render(<PlayerBoard state={state} seat={0} defaultOpen />);
    const mat = container.querySelector('svg.player-mat');
    expect(mat).not.toBeNull();
    expect(mat?.querySelector('image')?.getAttribute('href')).toBe('/assets/player-mat.jpg');
    // 29 框全渲染;棉 I 遮罩、棉 II 栈顶描边
    expect(container.querySelectorAll('[data-mat-slot]')).toHaveLength(29);
    const cotton1 = container.querySelector('[data-mat-slot="cotton-1"]');
    expect(cotton1?.querySelector('.mat-slot-exhausted')).not.toBeNull();
    const cotton2 = container.querySelector('[data-mat-slot="cotton-2"]');
    expect(cotton2?.querySelector('.mat-slot-top')).not.toBeNull();
    expect(cotton2?.textContent).toContain('×2');
    // 实物堆叠:栈顶按剩余数叠放玩家色板块 token(棉 II 剩 2 → 2 张图)
    const pile = cotton2?.querySelectorAll('.mat-pile image');
    expect(pile).toHaveLength(2);
    expect(pile?.[0]?.getAttribute('href')).toBe('/assets/tiles/cotton-2-purple.png');
    // 初始局面的制造厂 I(剩 1)→ 单块堆叠
    const m1 = container.querySelector('[data-mat-slot="manufacturer-1"]');
    expect(m1?.querySelectorAll('.mat-pile image')).toHaveLength(1);
    // 初始局面:每产业栈顶都是 Lv1(制造厂 8 框 + 其余 5 产业 = 6 个描边)
    expect(container.querySelectorAll('.mat-slot-top')).toHaveLength(6);
    // 切换明细后列表出现、版图消失
    fireEvent.click(screen.getByTestId('stack-view-list-0'));
    expect(container.querySelector('svg.player-mat')).toBeNull();
    expect(screen.getByTestId('player-board-stack-0-pottery-5')).toHaveTextContent('×1');
  });

  it('已建板块渲染官方板块缩略图（含翻面态）', () => {
    const state = freshState();
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
    const cottonThumb = screen.getByTestId('player-board-tile-0-cotton-0');
    expect(cottonThumb.classList.contains('flipped')).toBe(true);
    expect(cottonThumb.querySelector('img')?.getAttribute('src')).toBe(
      '/assets/tiles/cotton-2-purple-back.png',
    );
    const coalThumb = screen.getByTestId('player-board-tile-0-coal-0');
    expect(coalThumb.querySelector('img')?.getAttribute('src')).toBe(
      '/assets/tiles/coal-1-purple.png',
    );
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

  it('显示各人本轮已花金额、现金与昵称', () => {
    const state = freshState();
    const p0 = state.players[0];
    if (p0 === undefined) throw new Error('fixture 缺玩家 0');
    p0.spentThisRound = 5;
    render(<TurnOrderBar state={state} room={roomFixture()} />);
    const item = screen.getByTestId('turn-order').querySelector('[data-player="0"]');
    expect(item).toHaveTextContent('甲');
    expect(item).toHaveTextContent('已花 £5');
    expect(item).toHaveTextContent('£17');
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

  it('自己手牌：官方卡面图 + 中文名（地点卡=城市，产业卡=产业）', () => {
    const state = handState([
      { id: 'l0', kind: 'location', location: 'birmingham' },
      { id: 'i0', kind: 'industry', industries: ['cotton', 'manufacturer'] },
    ]);
    render(<HandBar state={state} seat={0} />);
    const cardL = screen.getByTestId('hand-card-l0');
    expect(cardL).toHaveTextContent('伯明翰');
    expect(cardL.querySelector('img')?.getAttribute('src')).toBe('/assets/cards/loc-birmingham.png');
    const cardI = screen.getByTestId('hand-card-i0');
    expect(cardI).toHaveTextContent('棉纺厂/制造厂');
    expect(cardI.classList.contains('wild')).toBe(false);
  });

  it('多美术牌面按副本序号轮转（ind-brewery 3 张）', () => {
    expect(cardImageSrc({ id: 'ind-brewery-0', kind: 'industry', industries: ['brewery'] })).toBe(
      '/assets/cards/ind-brewery.png',
    );
    expect(cardImageSrc({ id: 'ind-brewery-1', kind: 'industry', industries: ['brewery'] })).toBe(
      '/assets/cards/ind-brewery@2.png',
    );
    expect(cardImageSrc({ id: 'ind-brewery-2', kind: 'industry', industries: ['brewery'] })).toBe(
      '/assets/cards/ind-brewery@3.png',
    );
    expect(cardImageSrc({ id: 'ind-brewery-3', kind: 'industry', industries: ['brewery'] })).toBe(
      '/assets/cards/ind-brewery.png',
    );
  });

  it('wild 卡带百搭角标与中文名', () => {
    const state = handState([
      { id: 'w0', kind: 'wild-location' },
      { id: 'w1', kind: 'wild-industry' },
    ]);
    render(<HandBar state={state} seat={0} />);
    expect(screen.getByTestId('hand-card-w0').classList.contains('wild')).toBe(true);
    expect(screen.getByTestId('hand-card-w0')).toHaveTextContent('百搭·城市');
    expect(screen.getByTestId('hand-card-w1')).toHaveTextContent('百搭·产业');
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
  it('渲染 action_applied 流：seq、玩家、中文行动摘要', () => {
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
    expect(entries[0]).toHaveTextContent('建造 煤矿（伯明翰）');
    expect(entries[1]).toHaveTextContent('贷款');
    expect(entries[2]).toHaveTextContent('侦察');
  });

  it('空日志显示占位文本', () => {
    render(<LogPanel log={[]} />);
    expect(screen.getByTestId('log-empty')).toBeInTheDocument();
  });
});
