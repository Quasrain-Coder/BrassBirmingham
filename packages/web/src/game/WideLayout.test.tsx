/**
 * EraActions("本时代行动"折叠记录)测试:折叠态只显示计数,展开按顺序列出
 * 简化描述;空记录显示占位文案。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Action } from '@brass/engine';
import { EraActions } from './WideLayout';

const ACTIONS: Action[] = [
  { type: 'loan', cardId: 'c1' },
  { type: 'build', cardId: 'c2', location: 'birmingham', industry: 'cotton' },
  { type: 'pass', cardId: 'c3' },
];

describe('<EraActions>', () => {
  it('折叠显示计数,展开按序列出简化描述', () => {
    render(<EraActions seat={0} actions={ACTIONS} />);
    const toggle = screen.getByTestId('era-actions-toggle-0');
    expect(toggle).toHaveTextContent('本时代 3 动');
    // 展开
    fireEvent.click(toggle);
    const items = screen.getByTestId('era-actions-0').querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('贷款');
    expect(items[1]).toHaveTextContent('建造 伯明翰棉纺厂');
    expect(items[2]).toHaveTextContent('过');
    // 收起
    fireEvent.click(toggle);
    expect(screen.getByTestId('era-actions-0').querySelectorAll('li')).toHaveLength(0);
  });

  it('空记录:展开显示占位', () => {
    render(<EraActions seat={1} actions={[]} />);
    fireEvent.click(screen.getByTestId('era-actions-toggle-1'));
    expect(screen.getByTestId('era-actions-1')).toHaveTextContent('本时代尚未行动');
  });
});
