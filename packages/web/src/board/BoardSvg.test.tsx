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
    expect(container.querySelectorAll('line.board-link')).toHaveLength(LINKS.length);
  });

  it('viewBox 取官方版图有效区域', () => {
    const { container } = render(<BoardSvg state={freshState()} />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('990 990 4200 4200');
  });

  it('渲染 5 个商人位与每个城市的产业槽位热区', () => {
    const { container } = render(<BoardSvg state={freshState()} />);
    expect(container.querySelectorAll('g.board-merchant-group')).toHaveLength(5);
    const totalSlots = Object.values(LOCATIONS).reduce((n, loc) => n + loc.slots.length, 0);
    expect(container.querySelectorAll('rect.board-slot')).toHaveLength(totalSlots);
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

    const link = container.querySelector('line[data-link-index="0"]') as Element;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(linkClicks).toEqual([0]);
  });

  it('已建 Link 加 board-link-built 类并画玩家色路径，highlights 加 highlighted 类', () => {
    const state = freshState();
    state.board.links.push({ linkIndex: 0, player: 1 });
    const { container } = render(
      <BoardSvg
        state={state}
        highlights={{ slots: [{ location: 'derby', slotIndex: 2 }], links: [3] }}
      />,
    );
    const built = container.querySelector('line[data-link-index="0"]') as SVGLineElement;
    expect(built.classList.contains('board-link-built')).toBe(true);
    const visual = container.querySelector('polyline.board-link-visual') as SVGPolylineElement;
    expect(visual.getAttribute('stroke')).toBe(PLAYER_COLORS[1]);
    const hl = container.querySelector('line[data-link-index="3"]') as SVGLineElement;
    expect(hl.classList.contains('highlighted')).toBe(true);
    const slot = container.querySelectorAll(
      'g[data-location="derby"] rect.board-slot',
    )[2] as Element;
    expect(slot.classList.contains('highlighted')).toBe(true);
  });

  it('已建板块渲染官方板块图（产业-等级-玩家色），资源数角标 resources>0 才显示', () => {
    const state = freshState();
    const coal = tileDef('coal', 1);
    if (coal === undefined) throw new Error('缺 coal level 1 TileDef');
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
    const { container } = render(<BoardSvg state={state} />);
    const tiles = container.querySelectorAll('g[data-location="birmingham"] image.board-tile');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]?.getAttribute('href')).toBe('/assets/tiles/coal-1-purple.png');
    expect(tiles[1]?.getAttribute('href')).toBe('/assets/tiles/coal-1-yellow-back.png');
    const badges = container.querySelectorAll(
      'g[data-location="birmingham"] .tile-resources',
    );
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain('3');
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
