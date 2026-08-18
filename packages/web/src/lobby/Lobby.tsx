/**
 * 大厅与房间等待视图（M2 Task 12；等待大厅视觉翻新）。
 * - Lobby：创建房间（昵称 + 人数 + AI 座位/难度 + 可选种子）/ 加入房间（昵称 + 房间号）
 *   两个面板，未连接或昵称为空时提交不可用；服务器错误（room-not-found 等）直接展示。
 * - RoomView：房间号"车票"卡片（可一键复制）、座位卡片列表（头像/昵称/在线状态/"我"
 *   标记/AI 徽章与难度）、就位进度条、开始按钮（满员才可用，任意座位可点）、离开房间。
 *
 * 视觉：工业时代主题（深色暖调 + 黄铜色），样式在 style.css "等待大厅" 一节。
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import type { AIDifficulty, RoomConfig } from '@brass/protocol';
import type { GameStore } from '../game/store';
import { useGameStore } from '../game/store';

/** 解析可选种子：留空/非整数 → 不带 seed（服务器随机）。 */
function parseSeed(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/** AI 难度中文标签——与 packages/server/src/rooms.ts DIFFICULTY_LABEL 同步（双拷贝，改动需同步两侧）。 */
const AI_DIFFICULTY_LABEL: Record<AIDifficulty, string> = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
};
const AI_DIFFICULTIES: readonly AIDifficulty[] = ['easy', 'normal', 'hard'];

const CONNECTION_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '正在连接服务器…',
  disconnected: '未连接',
};

/** 连接状态点色调（ok 绿 / pending 琥珀 / bad 红）。 */
const CONNECTION_TONE: Record<string, string> = {
  connected: 'ok',
  connecting: 'pending',
  disconnected: 'bad',
};

/** 表单字段包装：统一 label + 控件布局与焦点样式。 */
function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/**
 * 房间号复制按钮：clipboard 不可用（非 https / jsdom）时降级为选中房间号文本，
 * 复制后短暂显示"已复制"（1.5s 后还原）。
 */
function CopyCodeButton({ code }: { code: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const onCopy = (): void => {
    if (navigator.clipboard !== undefined) {
      navigator.clipboard.writeText(code).catch(() => selectRoomCode());
    } else {
      selectRoomCode();
    }
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="copy-code" data-testid="copy-code" onClick={onCopy}>
      {copied ? '已复制' : '复制'}
    </button>
  );
}

/** 降级路径：选中房间号文本，提示用户手动复制。 */
function selectRoomCode(): void {
  const el = document.querySelector<HTMLElement>('[data-testid="room-code"]');
  if (el === null) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function Lobby({ store }: { store: GameStore }): ReactElement {
  const s = useGameStore(store);
  const connected = s.connection === 'connected';
  const [createNick, setCreateNick] = useState('');
  const [playerCount, setPlayerCount] = useState('4');
  const [seed, setSeed] = useState('');
  const [aiCount, setAiCount] = useState('0');
  const [aiDifficulty, setAiDifficulty] = useState<AIDifficulty>('normal');
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
    const ai = Number(aiCount);
    // 合法域 0..playerCount-1（选项已 clamp，这里再守一道）
    if (Number.isInteger(ai) && ai >= 1 && ai <= config.playerCount - 1) {
      config.aiSeats = { count: ai, difficulty: aiDifficulty };
    }
    store.createRoom(nickname, config);
  };

  /** 人数变化：AI 数选项上界随之收紧，已选值 clamp 到 playerCount-1。 */
  const onPlayerCountChange = (value: string): void => {
    setPlayerCount(value);
    const maxAI = Number(value) - 1;
    if (Number(aiCount) > maxAI) setAiCount(String(maxAI));
  };

  const onJoin = (e: FormEvent): void => {
    e.preventDefault();
    const nickname = joinNick.trim();
    const code = joinCode.trim();
    if (!connected || nickname === '' || code === '') return;
    store.joinRoom(code, nickname);
  };

  return (
    <main className="app lobby">
      <header className="lobby-hero">
        <p className="eyebrow">工业革命 · 运河与铁路</p>
        <h1>Brass: Birmingham</h1>
        <p className="subtitle">在线对局大厅</p>
        <p
          className={`connection-pill ${CONNECTION_TONE[s.connection] ?? 'bad'}`}
          data-testid="connection-status"
        >
          <span className="connection-dot" aria-hidden="true" />
          {CONNECTION_LABEL[s.connection] ?? s.connection}
        </p>
      </header>
      {s.lastError !== null ? (
        <p className="error-banner" data-testid="last-error" role="alert">
          {s.lastError.code}: {s.lastError.message}
        </p>
      ) : null}

      <div className="lobby-panels">
        <form className="panel" data-testid="create-form" onSubmit={onCreate}>
          <h2 className="panel-title">创建房间</h2>
          <p className="panel-desc">开一局新对局，把房间号分享给朋友</p>
          <Field label="昵称">
            <input
              data-testid="create-nickname"
              value={createNick}
              placeholder="你的名字"
              onChange={(e) => setCreateNick(e.target.value)}
            />
          </Field>
          <div className="field-row">
            <Field label="人数">
              <select
                data-testid="create-player-count"
                value={playerCount}
                onChange={(e) => onPlayerCountChange(e.target.value)}
              >
                <option value="2">2 人</option>
                <option value="3">3 人</option>
                <option value="4">4 人</option>
              </select>
            </Field>
            <Field label="AI 座位">
              <select
                data-testid="create-ai-count"
                value={aiCount}
                onChange={(e) => setAiCount(e.target.value)}
              >
                {Array.from({ length: Number(playerCount) }, (_, i) => (
                  <option key={i} value={String(i)}>
                    {i === 0 ? '无' : `${i} 个`}
                  </option>
                ))}
              </select>
            </Field>
            {aiCount !== '0' ? (
              <Field label="AI 难度">
                <select
                  data-testid="create-ai-difficulty"
                  value={aiDifficulty}
                  onChange={(e) => setAiDifficulty(e.target.value as AIDifficulty)}
                >
                  {AI_DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>
                      {AI_DIFFICULTY_LABEL[d]}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>
          <Field label="种子（可选）">
            <input
              data-testid="create-seed"
              value={seed}
              placeholder="留空随机"
              onChange={(e) => setSeed(e.target.value)}
            />
          </Field>
          <button
            type="submit"
            className="btn-primary"
            data-testid="create-submit"
            disabled={!connected || createNick.trim() === ''}
          >
            创建房间
          </button>
        </form>

        <form className="panel" data-testid="join-form" onSubmit={onJoin}>
          <h2 className="panel-title">加入房间</h2>
          <p className="panel-desc">输入朋友分享的 6 位房间号</p>
          <Field label="昵称">
            <input
              data-testid="join-nickname"
              value={joinNick}
              placeholder="你的名字"
              onChange={(e) => setJoinNick(e.target.value)}
            />
          </Field>
          <Field label="房间号">
            <input
              data-testid="join-code"
              value={joinCode}
              placeholder="例如 AB23CD"
              maxLength={6}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/\s/g, ''))}
            />
          </Field>
          <button
            type="submit"
            className="btn-primary"
            data-testid="join-submit"
            disabled={!connected || joinNick.trim() === '' || joinCode.trim() === ''}
          >
            加入房间
          </button>
        </form>
      </div>
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
  const pct = Math.round((seated / room.seats.length) * 100);

  return (
    <main className="app room-view">
      <header className="room-hero">
        <p className="eyebrow">ROOM · 整装待发</p>
        <h1>等待大厅</h1>
      </header>

      <section className="code-ticket">
        <p className="code-label">房间号</p>
        <p className="room-code" data-testid="room-code">
          {room.code}
        </p>
        <CopyCodeButton code={room.code} />
        {room.customSeed ? (
          <p className="seed-badge" data-testid="custom-seed-badge">
            房主指定了种子
          </p>
        ) : null}
      </section>

      <section className="seat-panel">
        <header className="seat-panel-head">
          <h2>玩家席位</h2>
          <p className="seat-count" data-testid="seat-count">
            已就位 {seated}/{room.config.playerCount}
          </p>
        </header>
        <div className="progress-track" aria-hidden="true">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <ul className="seat-list">
          {room.seats.map((info, i) => (
            <li
              key={i}
              data-testid={`seat-${i}`}
              className={`seat-card hue-${i % 4}${info === null ? ' empty' : ''}`}
            >
              <span className="seat-avatar" aria-hidden="true">
                {info === null ? '·' : info.nickname.slice(0, 1)}
              </span>
              <span className="seat-body">
                {info === null ? (
                  <span className="seat-empty">空位</span>
                ) : info.isAI ? (
                  <>
                    <span className="seat-name">{info.nickname}</span>
                    <span className="ai-badge" data-testid={`seat-${i}-ai-badge`}>
                      AI
                      {room.config.aiSeats !== undefined
                        ? `·${AI_DIFFICULTY_LABEL[room.config.aiSeats.difficulty]}`
                        : ''}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="seat-name">
                      {info.nickname}
                      {info.seat === s.seat ? <span className="me-chip">（我）</span> : null}
                    </span>
                    <span className={`status-chip ${info.connected ? 'online' : 'offline'}`}>
                      <span className="status-dot" aria-hidden="true" />
                      {info.connected ? '在线' : '离线'}
                    </span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="room-actions">
        <button
          className="btn-primary btn-start"
          data-testid="start-game"
          disabled={!full || s.connection !== 'connected'}
          onClick={() => store.startGame()}
        >
          {full ? '开始对局' : '等待更多玩家…'}
        </button>
        {full ? null : <p className="hint">满员后才能开始</p>}
        <button className="btn-ghost" data-testid="leave-room" onClick={() => store.leaveRoom()}>
          离开房间
        </button>
      </section>
    </main>
  );
}
