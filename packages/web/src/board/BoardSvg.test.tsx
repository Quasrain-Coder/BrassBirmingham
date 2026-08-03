import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LINKS, LOCATIONS, MERCHANTS, newGame } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import { BoardSvg } from './BoardSvg';

/** 用确定性 seed 起一局 4 人局，取 0 号位视角的 FilteredState。 */
function freshState() {
  return filterStateFor(newGame(4, 42), 0);
}

describe('<BoardSvg>', () => {
  it('渲染 22 个城市 group 与 39 条连接边', () => {
    const { container } = render(<BoardSvg state={freshState()} />);
    expect(container.querySelectorAll('g.board-location')).toHaveLength(
      Object.keys(LOCATIONS).length,
    );
    expect(container.querySelectorAll('g.board-location')).toHaveLength(22);
    expect(container.querySelectorAll('line.board-link')).toHaveLength(LINKS.length);
    expect(container.querySelectorAll('line.board-link')).toHaveLength(39);
  });

  it('渲染 5 个商人位六边形与每个城市的产业槽位', () => {
    const { container } = render(<BoardSvg state={freshState()} />);
    expect(container.querySelectorAll('polygon.board-merchant')).toHaveLength(
      Object.keys(MERCHANTS).length,
    );
    const totalSlots = Object.values(LOCATIONS).reduce((n, loc) => n + loc.slots.length, 0);
    expect(container.querySelectorAll('rect.board-slot')).toHaveLength(totalSlots);
  });

  it('城市 group 带 data-location，槽位/边回调带上 id 与下标', () => {
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

  it('已建 Link 显示玩家色，highlights 加 highlighted 类', () => {
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
    const hl = container.querySelector('line[data-link-index="3"]') as SVGLineElement;
    expect(hl.classList.contains('highlighted')).toBe(true);
    const slot = container.querySelectorAll(
      'g[data-location="derby"] rect.board-slot',
    )[2] as Element;
    expect(slot.classList.contains('highlighted')).toBe(true);
  });
});
