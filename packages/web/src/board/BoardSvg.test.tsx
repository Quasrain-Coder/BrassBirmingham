import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LINKS, LINK_EXTRA_ENDPOINTS, LOCATIONS, newGame, tileDef } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import { BoardSvg, PLAYER_COLORS } from './BoardSvg';

/** 用确定性 seed 起一局 4 人局，取 0 号位视角的 FilteredState。 */
function freshState() {
  return filterStateFor(newGame(4, 42), 0);
}

describe('<BoardSvg>', () => {
  it('渲染官方版图底图与 22 个城市 group、39 条连接热区', () => {
    const { container } = render(<BoardSvg state={freshState()} />);
    const img = container.querySelector('image.board-image');
    expect(img?.getAttribute('href')).toBe('/assets/board.jpg');
    expect(container.querySelectorAll('g.board-location')).toHaveLength(
      Object.keys(LOCATIONS).length,
    );
    expect(container.querySelectorAll('.board-link')).toHaveLength(LINKS.length);
  });

  it('viewBox 取官方版图有效区域', () => {
    const { container } = render(<BoardSvg state={freshState()} />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('990 990 4200 4200');
  });

  it('顺位轨:角色头像嵌入顺位桶,本轮花费渲染钱币堆椭圆块', () => {
    const state = freshState();
    const cur = state.turnOrder[state.currentPlayerIdx]!;
    state.players[cur]!.spentThisRound = 7;
    const { container } = render(<BoardSvg state={state} thinkingSeats={[state.turnOrder[1]!]} />);
    const track = container.querySelector('g.board-turn-track');
    expect(track).not.toBeNull();
    // 4 个桶位各一个头像(圆形裁剪),当前玩家金圈(current 类),思考中 thinking 类
    expect(track?.querySelectorAll('image[clip-path]')).toHaveLength(4);
    expect(track?.querySelector(`[data-turn-seat="${cur}"]`)?.classList.contains('current')).toBe(true);
    expect(
      track?.querySelector(`[data-turn-seat="${state.turnOrder[1]!}"]`)?.classList.contains('thinking'),
    ).toBe(true);
    // 花费 £7:黄色加大数字,不再叠钱币堆
    const spent = track?.querySelector(`[data-testid="turn-spent-${cur}"]`);
    expect(spent).not.toBeNull();
    expect(spent?.querySelectorAll('image')).toHaveLength(0);
    expect(spent?.textContent).toContain('£7');
    // 未花费的玩家无椭圆块
    expect(container.querySelector(`[data-testid="turn-spent-${state.turnOrder[2]!}"]`)).toBeNull();
  });

  it('渲染 5 个商人位与每个城市的产业槽位热区', () => {
    const { container } = render(<BoardSvg state={freshState()} />);
    expect(container.querySelectorAll('g.board-merchant-group')).toHaveLength(5);
    const totalSlots = Object.values(LOCATIONS).reduce((n, loc) => n + loc.slots.length, 0);
    expect(container.querySelectorAll('rect.board-slot')).toHaveLength(totalSlots);
  });

  it('负分玩家(引擎 VP 可为负)不崩——负分固定显示在 0 位', () => {
    const state = freshState();
    state.players[0]!.vp = -3;
    state.players[1]!.vp = 103; // 超环回绕仍安全
    expect(() => render(<BoardSvg state={state} />)).not.toThrow();
  });

  it('槽位/边回调带上 id 与下标', () => {
    const clicks: [string, number][] = [];
    const linkClicks: number[] = [];
    const { container } = render(
      <BoardSvg
        state={freshState()}
        onSlotClick={(loc, i) => clicks.push([loc, i])}
        onLinkClick={(i) => linkClicks.push(i)}
      />,
    );
    expect(container.querySelector('g[data-location="birmingham"]')).not.toBeNull();

    const slot = container.querySelector(
      'g[data-location="birmingham"] rect.board-slot',
    ) as Element;
    slot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicks).toEqual([['birmingham', 0]]);

    const link = container.querySelector('[data-link-index="0"]') as Element;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(linkClicks).toEqual([0]);
  });

  it('已建 Link 只留中点时代 token(不再画整线玩家色),highlights 加 highlighted 类', () => {
    const state = freshState();
    state.board.links.push({ linkIndex: 0, player: 1, era: 'canal' });
    const { container } = render(
      <BoardSvg
        state={state}
        highlights={{ slots: [{ location: 'derby', slotIndex: 2 }], links: [3] }}
      />,
    );
    const built = container.querySelector('[data-link-index="0"]') as SVGLineElement;
    expect(built.classList.contains('board-link-built')).toBe(true);
    // 已建连接不再画整条玩家色路径(避免被误读为残留高亮),归属由中点 token 表达
    expect(container.querySelector('polyline.board-link-visual')).toBeNull();
    // 运河时代建的 → 驳船 token；高亮连线中点出现 + 提示牌
    const token = container.querySelector('.link-token image');
    expect(token?.getAttribute('href')).toBe('/assets/link-canal.png');
    expect(container.querySelector('.link-hl-chip')).not.toBeNull();
    const hl = container.querySelector('[data-link-index="3"]') as SVGLineElement;
    expect(hl.classList.contains('highlighted')).toBe(true);
    const slot = container.querySelectorAll(
      'g[data-location="derby"] rect.board-slot',
    )[2] as Element;
    expect(slot.classList.contains('highlighted')).toBe(true);
  });

  it('已建板块渲染官方板块图（产业-等级-玩家色），资源 token 按数渲染', () => {
    const state = freshState();
    const coal = tileDef('coal', 1);
    const brewery = tileDef('brewery', 1);
    if (coal === undefined || brewery === undefined) throw new Error('缺 TileDef');
    state.board.slots['birmingham']![0] = {
      tile: coal,
      player: 0,
      flipped: false,
      resources: 3,
    };
    state.board.slots['birmingham']![1] = {
      tile: coal,
      player: 1,
      flipped: true,
      resources: 0,
    };
    state.board.slots['derby']![0] = {
      tile: brewery,
      player: 2,
      flipped: false,
      resources: 1,
    };
    const { container } = render(<BoardSvg state={state} />);
    const tiles = container.querySelectorAll('g[data-location="birmingham"] image.board-tile');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]?.getAttribute('href')).toBe('/assets/tiles/coal-1-purple.png');
    expect(tiles[1]?.getAttribute('href')).toBe('/assets/tiles/coal-1-yellow-back.png');
    // 资源 token：3 煤方块 + 1 啤酒桶；数字角标同步
    const badges = container.querySelectorAll(
      'g[data-location="birmingham"] .tile-resources',
    );
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain('3');
    expect(
      container.querySelectorAll('g[data-location="birmingham"] .tile-resource-tokens rect'),
    ).toHaveLength(6); // 3 方块 ×（本体+高光）
    expect(
      container.querySelectorAll('g[data-location="derby"] .tile-resource-tokens .board-merchant-beer'),
    ).toHaveLength(1); // 酒厂商用立桶(自绘,非贴图)
  });

  it('煤/铁市场按 filled 渲染方块（初始煤 13 铁 8）', () => {
    const { container } = render(<BoardSvg state={freshState()} />);
    expect(container.querySelectorAll('.board-markets > g')).toHaveLength(13 + 8);
  });

  it('三端点边的 farm-south 分支线同样可点（行为同主干）', () => {
    const branchIdx = Number(Object.keys(LINK_EXTRA_ENDPOINTS)[0]);
    const linkClicks: number[] = [];
    const { container } = render(
      <BoardSvg state={freshState()} onLinkClick={(i) => linkClicks.push(i)} />,
    );
    const branch = container.querySelector('line.board-link-branch') as Element;
    expect(branch.getAttribute('data-link-index')).toBe(String(branchIdx));
    branch.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(linkClicks).toEqual([branchIdx]);
  });
});
