/**
 * 大厅与房间等待视图（M2 Task 12）。
 * - Lobby：创建房间（昵称 + 人数 + 可选种子）/ 加入房间（昵称 + 房间号）两个表单，
 *   未连接或昵称为空时提交不可用；服务器错误（room-not-found 等）直接展示。
 * - RoomView：房间号大字、customSeed 公开标记、座位列表（昵称/在线状态/"我"标记）、
 *   就位计数、开始按钮（满员才可用，任意座位可点）、离开房间。
 */
import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { RoomConfig } from '@brass/protocol';
import type { GameStore } from '../game/store';
import { useGameStore } from '../game/store';

/** 解析可选种子：留空/非整数 → 不带 seed（服务器随机）。 */
function parseSeed(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

const CONNECTION_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '正在连接服务器…',
  disconnected: '未连接',
};

export function Lobby({ store }: { store: GameStore }): ReactElement {
  const s = useGameStore(store);
  const connected = s.connection === 'connected';
  const [createNick, setCreateNick] = useState('');
  const [playerCount, setPlayerCount] = useState('4');
  const [seed, setSeed] = useState('');
  const [joinNick, setJoinNick] = useState('');
  const [joinCode, setJoinCode] = useState('');

  const onCreate = (e: FormEvent): void => {
    e.preventDefault();
    const nickname = createNick.trim();
    if (!connected || nickname === '') return;
    const count = Number(playerCount);
    const config: RoomConfig = { playerCount: count === 2 || count === 3 ? count : 4 };
    const parsed = parseSeed(seed);
    if (parsed !== undefined) config.seed = parsed;
    store.createRoom(nickname, config);
  };

  const onJoin = (e: FormEvent): void => {
    e.preventDefault();
    const nickname = joinNick.trim();
    const code = joinCode.trim().toUpperCase();
    if (!connected || nickname === '' || code === '') return;
    store.joinRoom(code, nickname);
  };

  return (
    <main className="app lobby">
      <h1>Brass: Birmingham</h1>
      <p className="subtitle">在线对局大厅</p>
      <p className="status" data-testid="connection-status">
        {CONNECTION_LABEL[s.connection] ?? s.connection}
      </p>
      {s.lastError !== null ? (
        <p className="error" data-testid="last-error">
          {s.lastError.code}: {s.lastError.message}
        </p>
      ) : null}

      <form className="lobby-form" data-testid="create-form" onSubmit={onCreate}>
        <h2>创建房间</h2>
        <label>
          昵称
          <input
            data-testid="create-nickname"
            value={createNick}
            onChange={(e) => setCreateNick(e.target.value)}
          />
        </label>
        <label>
          人数
          <select
            data-testid="create-player-count"
            value={playerCount}
            onChange={(e) => setPlayerCount(e.target.value)}
          >
            <option value="2">2 人</option>
            <option value="3">3 人</option>
            <option value="4">4 人</option>
          </select>
        </label>
        <label>
          种子（可选）
          <input
            data-testid="create-seed"
            value={seed}
            placeholder="留空随机"
            onChange={(e) => setSeed(e.target.value)}
          />
        </label>
        <button
          type="submit"
          data-testid="create-submit"
          disabled={!connected || createNick.trim() === ''}
        >
          创建房间
        </button>
      </form>

      <form className="lobby-form" data-testid="join-form" onSubmit={onJoin}>
        <h2>加入房间</h2>
        <label>
          昵称
          <input
            data-testid="join-nickname"
            value={joinNick}
            onChange={(e) => setJoinNick(e.target.value)}
          />
        </label>
        <label>
          房间号
          <input
            data-testid="join-code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
          />
        </label>
        <button
          type="submit"
          data-testid="join-submit"
          disabled={!connected || joinNick.trim() === '' || joinCode.trim() === ''}
        >
          加入房间
        </button>
      </form>
    </main>
  );
}

export function RoomView({ store }: { store: GameStore }): ReactElement {
  const s = useGameStore(store);
  const room = s.room;
  if (room === null) {
    return (
      <p className="status" data-testid="no-room">
        等待房间信息…
      </p>
    );
  }
  const seated = room.seats.filter((info) => info !== null).length;
  const full = seated === room.seats.length;

  return (
    <main className="app room-view">
      <h1>房间</h1>
      <p className="room-code" data-testid="room-code">
        {room.code}
      </p>
      {room.customSeed ? (
        <p className="seed-badge" data-testid="custom-seed-badge">
          房主指定了种子
        </p>
      ) : null}
      <p className="status" data-testid="seat-count">
        已就位 {seated}/{room.config.playerCount}
      </p>
      <ul className="seat-list">
        {room.seats.map((info, i) => (
          <li key={i} data-testid={`seat-${i}`}>
            {info === null ? (
              <span className="seat-empty">空位</span>
            ) : (
              <>
                <span className="seat-name">
                  {info.nickname}
                  {info.seat === s.seat ? '（我）' : ''}
                </span>{' '}
                <span className={info.connected ? 'seat-online' : 'seat-offline'}>
                  {info.connected ? '在线' : '离线'}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <button
        data-testid="start-game"
        disabled={!full}
        onClick={() => store.startGame()}
      >
        开始对局
      </button>
      {full ? null : <p className="status">满员后才能开始</p>}
      <button data-testid="leave-room" onClick={() => store.leaveRoom()}>
        离开房间
      </button>
    </main>
  );
}
