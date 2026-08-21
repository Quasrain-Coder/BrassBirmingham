/**
 * DiscardModal 测试：本时代打出记录——运河时代每列首张为开局暗置卡背,
 * 已打出的牌按顺序展示;铁路时代无暗置首张。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { newGame } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import { DiscardModal } from './DiscardModal';
import { cardName } from './display';

describe('<DiscardModal>', () => {
  it('运河时代:每列首张暗置卡背,已打出牌按序列出并计总数', () => {
    const game = newGame(4, 42);
    const state = filterStateFor(game, 0);
    const card = game.players[1]!.hand[0]!;
    render(
      <DiscardModal state={state} playedCards={[[], [card], [], []]} onClose={() => {}} />,
    );
    // 每列都有暗置卡背(4 人局 = 4 张开局暗弃)
    for (let i = 0; i < 4; i += 1) {
      const col = screen.getByTestId(`discard-col-${i}`);
      expect(col.querySelector('img.discard-card-back')).not.toBeNull();
    }
    // 座位 1 已打出 1 张:暗置 + 该卡,标题计数 2
    const col1 = screen.getByTestId('discard-col-1');
    expect(col1.querySelector(`img[alt="${cardName(card)}"]`)).not.toBeNull();
    expect(col1).toHaveTextContent('（2）');
    // 空列只计暗置 1 张
    expect(screen.getByTestId('discard-col-0')).toHaveTextContent('（1）');
  });

  it('铁路时代:无暗置首张', () => {
    const game = newGame(4, 42);
    const state = { ...filterStateFor(game, 0), era: 'rail' as const };
    render(<DiscardModal state={state} playedCards={[[], [], [], []]} onClose={() => {}} />);
    expect(screen.getByTestId('discard-col-0').querySelector('img.discard-card-back')).toBeNull();
    expect(screen.getByTestId('discard-col-0')).toHaveTextContent('（0）');
  });
});
