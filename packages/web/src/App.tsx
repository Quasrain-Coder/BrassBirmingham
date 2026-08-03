import type { ReactElement } from 'react';

/**
 * M2 Task 8 脚手架占位页：确认静态托管与 /ws 链路可用。
 * 大厅/对局界面在后续 task 以条件渲染接入（不引路由库）。
 */
export function App(): ReactElement {
  return (
    <main className="app">
      <h1>Brass: Birmingham</h1>
      <p className="subtitle">在线对局 — M2 脚手架</p>
      <p className="status">正在连接服务器…</p>
    </main>
  );
}
