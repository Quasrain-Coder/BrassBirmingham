import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('<App> 冒烟', () => {
  it('渲染标题与连接占位文本', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Brass: Birmingham' })).toBeInTheDocument();
    expect(screen.getByText('正在连接服务器…')).toBeInTheDocument();
  });
});
