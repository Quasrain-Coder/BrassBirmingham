import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { GameScreen } from './game/GameScreen';
import { GameClient, GameStore, useGameStore } from './game/store';

/** 同源 ws 端点（server 静态托管 + /ws 升级，见 M2 Task 8）。 */
function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

/**
 * 入口：无快照时显示连接占位（大厅在后续 task 接入——create/join 房间后
 * server 才会下发 snapshot）；有快照即进入对局画面（Task 11 交互层）。
 */
export function App(): ReactElement {
  const [store] = useState(() => new GameStore(new GameClient(wsUrl())));
  useEffect(() => {
    store.connect();
    return () => store.disconnect();
  }, [store]);
  const s = useGameStore(store);

  if (s.snapshot !== null && s.seat !== null) {
    return <GameScreen store={store} />;
  }

  return (
    <main className="app">
      <h1>Brass: Birmingham</h1>
      <p className="subtitle">在线对局 — M2 脚手架</p>
      <p className="status">正在连接服务器…</p>
      {s.lastError !== null ? (
        <p className="error" data-testid="last-error">
          {s.lastError.code}: {s.lastError.message}
        </p>
      ) : null}
    </main>
  );
}
