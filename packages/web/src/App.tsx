/**
 * 入口与路由（M2 Task 12）：条件渲染，不引路由库。
 * - takenOver → "连接被另一标签页接管"画面（重新接管 / 返回大厅）
 * - gameOver → 终局画面（胜者 + 各座位分数 + 返回大厅）
 * - snapshot → GameScreen 对局画面
 * - room → RoomView 房间等待视图
 * - 否则 → Lobby 大厅（创建/加入）
 *
 * 启动时 restoreSession() 读 localStorage 里的 token（`brass:token:<code>`），
 * connect 后由 store 自动 resume 抢回座位（刷新恢复）。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { RoomState } from '@brass/protocol';
import { GameScreen } from './game/GameScreen';
import { playerName } from './game/Panels';
import { GameClient, GameStore, useGameStore } from './game/store';
import type { GameOverInfo } from './game/store';
import { Lobby, RoomView } from './lobby/Lobby';

/** 同源 ws 端点（server 静态托管 + /ws 升级，见 M2 Task 8）。 */
function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

function GameOverScreen({
  store,
  gameOver,
  room,
}: {
  store: GameStore;
  gameOver: GameOverInfo;
  room: RoomState | null;
}): ReactElement {
  return (
    <main className="app game-over-screen">
      <h1>对局结束</h1>
      <p data-testid="winner">
        胜者：{gameOver.winner.map((w) => playerName(room ?? undefined, w)).join('、')}
      </p>
      <ul data-testid="final-scores">
        {gameOver.finalScores.map((score, seat) => (
          <li key={seat}>
            {playerName(room ?? undefined, seat)}：{score} 分
          </li>
        ))}
      </ul>
      <button data-testid="back-lobby" onClick={() => store.leaveRoom()}>
        返回大厅
      </button>
    </main>
  );
}

function TakenOverScreen({ store }: { store: GameStore }): ReactElement {
  return (
    <main className="app taken-over-screen">
      <h1>Brass: Birmingham</h1>
      <p className="error" data-testid="taken-over">
        连接被另一标签页接管
      </p>
      <p className="status">该座位已在其他标签页中恢复。可重新接管（对方将被断开），或返回大厅。</p>
      <button data-testid="reclaim" onClick={() => store.reclaim()}>
        重新接管
      </button>
      <button data-testid="back-lobby" onClick={() => store.leaveRoom()}>
        返回大厅
      </button>
    </main>
  );
}

export function App({ store: injected }: { store?: GameStore } = {}): ReactElement {
  const [store] = useState(() => {
    const s = injected ?? new GameStore(new GameClient(wsUrl()));
    s.restoreSession();
    return s;
  });
  useEffect(() => {
    store.connect();
    return () => store.disconnect();
  }, [store]);
  const s = useGameStore(store);

  if (s.takenOver) {
    return <TakenOverScreen store={store} />;
  }
  if (s.gameOver !== null) {
    return <GameOverScreen store={store} gameOver={s.gameOver} room={s.room} />;
  }
  if (s.snapshot !== null && s.seat !== null) {
    return <GameScreen store={store} />;
  }
  if (s.room !== null) {
    return <RoomView store={store} />;
  }
  return <Lobby store={store} />;
}
