/**
 * 回看模式（导入对局记录后的纯前端逐步回放）：布局对标正式对战——
 * 第一行：离开回看 / 原始房间号 / 进度控件(首尾步进+进度条) / 视角切换 / 从此处实战;
 * 左上玩家列右上方为时代标记;左右两列个人版图(含本回合与历史行动簿记);
 * 底部悬浮手牌(随视角切换);行动日志/分数构成/提示卡与对战同款弹窗。
 */
import { useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { buildDeck } from '@brass/engine';
import type { PlayerIndex } from '@brass/engine';
import type { RoomState } from '@brass/protocol';
import { BoardSvg } from '../board/BoardSvg';
import { HandBar, PlayerBoard } from './Panels';
import { ActionLogModal } from './DiscardModal';
import { ScoreModal, type EraScoreEntry } from './ScoreTable';
import { HintPopup } from './HintPopup';
import { PrefsModal } from './PrefsModal';
import type { HandRaiseMode, StackViewMode } from './PrefsModal';
import { replayFrame } from './replayFrame';
import { useGameStore, type GameStore } from './store';

export function ReviewScreen({ store }: { store: GameStore }): ReactElement {
  const review = useGameStore(store).review;
  const [logOpen, setLogOpen] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [hintAnchor, setHintAnchor] = useState<DOMRect | null>(null);
  const hintBtnRef = useRef<HTMLButtonElement>(null);
  // 偏好设置(与对战共用 localStorage;布局在回看固定为宽屏,仅卡牌悬浮/版图风格/日志风格生效)
  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  const [handRaise, setHandRaise] = useState<HandRaiseMode>(
    () => (storage?.getItem('brass-hand-raise') as HandRaiseMode | null) ?? 'single',
  );
  const [stackView, setStackView] = useState<StackViewMode>(
    () => (storage?.getItem('brass-stack-view') === 'list' ? 'list' : 'mat'),
  );
  const [logStyle, setLogStyle] = useState<'split' | 'grouped'>(
    () => (storage?.getItem('brass-log-style') === 'grouped' ? 'grouped' : 'split'),
  );

  const frame = useMemo(
    () => (review === null ? null : replayFrame(review.record, review.step, review.viewSeat)),
    [review],
  );

  if (review === null || frame === null) return <></>;
  const { record, step, viewSeat } = review;
  const { state, eraActions, playedCards, canalEntry } = frame;
  const total = record.actions.length;
  const pc = record.playerCount;
  const seats = Array.from({ length: pc }, (_, i) => i as PlayerIndex);
  const leftSeats = seats.slice(0, Math.ceil(pc / 2));
  const rightSeats = seats.slice(Math.ceil(pc / 2));

  const room: RoomState = {
    code: record.roomCode ?? '回放',
    config: { playerCount: pc, seed: record.seed },
    customSeed: true,
    started: true,
    seats: record.seats.map((s, i) => ({
      seat: i as PlayerIndex,
      nickname: s.nickname,
      isAI: s.isAI,
      connected: true,
    })),
  };

  // 时代内当前轮号(与 GameScreen 同一推算:全座位真实行动数 ÷ 每轮行动数)
  const real = eraActions.reduce((n, l) => n + l.filter((a) => a.note !== 'round-income').length, 0);
  const roundNow =
    state.era === 'canal' ? (real <= pc ? 1 : 2 + Math.floor((real - pc) / (2 * pc))) : Math.floor(real / (2 * pc)) + 1;
  const eraTotal = buildDeck(pc as 2 | 3 | 4).length / (2 * pc);
  const eraRoundText = `${state.era === 'canal' ? '运河时代' : '铁路时代'} · 第 ${Math.min(roundNow, eraTotal)}/${eraTotal} 轮`;

  const scoreEntries: EraScoreEntry[] = canalEntry !== null ? [canalEntry] : [];

  const boardOf = (i: PlayerIndex): ReactElement => (
    <PlayerBoard
      key={i}
      state={state}
      seat={i}
      room={room}
      compact
      playedCards={playedCards[i] ?? []}
      eraActions={eraActions[i] ?? []}
      roundNow={roundNow}
      stackView={stackView}
      seatSwitch={{ current: viewSeat, onSwitch: (s) => store.setReviewSeat(s) }}
    />
  );

  return (
    <div className="game-screen wide review-screen" data-testid="review-screen">
      <header className="review-topline">
        <span className="game-room-code" data-testid="review-room-code">房间 {room.code}</span>
        <button type="button" className="btn-ghost" data-testid="review-close" onClick={() => store.exitReview()}>
          离开回看
        </button>
        <button
          type="button"
          data-testid="review-start-here"
          disabled={state.phase === 'game-over'}
          title={state.phase === 'game-over' ? '终局面不可实战' : '以当前局面为残局开新房间(其余座位开放加入)'}
          onClick={() => store.startFromReview()}
        >
          从此处实战
        </button>
        <span className="era-round" data-testid="review-era-round">{eraRoundText}</span>
        <span className="review-controls" data-testid="review-controls">
          <button type="button" disabled={step === 0} title="开头" onClick={() => store.setReviewStep(0)}>
            ⏮
          </button>
          <button type="button" data-testid="review-prev" disabled={step === 0} title="上一步" onClick={() => store.setReviewStep(step - 1)}>
            ◀
          </button>
          <input
            type="range"
            min={0}
            max={total}
            value={step}
            aria-label="回放进度"
            onChange={(e) => store.setReviewStep(Number(e.target.value))}
          />
          <button type="button" data-testid="review-next" disabled={step >= total} title="下一步" onClick={() => store.setReviewStep(step + 1)}>
            ▶
          </button>
          <button type="button" disabled={step >= total} title="末尾" onClick={() => store.setReviewStep(total)}>
            ⏭
          </button>
          <span className="review-progress" data-testid="review-progress">
            {step}/{total}
          </span>
        </span>
        <span className="review-utils">
          <button type="button" className="btn-ghost" data-testid="review-open-prefs" onClick={() => setPrefsOpen(true)}>
            偏好设置
          </button>
          <button type="button" className="btn-ghost" data-testid="review-open-score" onClick={() => setScoreOpen(true)}>
            分数构成
          </button>
          <button type="button" className="btn-ghost" data-testid="review-open-log" onClick={() => setLogOpen(true)}>
            行动日志
          </button>
          <button
            ref={hintBtnRef}
            type="button"
            className="btn-ghost"
            data-testid="review-open-hint"
            onClick={() => setHintAnchor(hintAnchor === null ? hintBtnRef.current!.getBoundingClientRect() : null)}
          >
            提示卡
          </button>
        </span>
      </header>
      <div className="wide-grid">
        <aside className="wide-col wide-col-left">
          {leftSeats.map(boardOf)}
        </aside>
        <div className="wide-center">
          <BoardSvg state={state} />
        </div>
        <aside className="wide-col wide-col-right">{rightSeats.map(boardOf)}</aside>
      </div>
      <div className="review-hand">
        <HandBar
          state={state}
          seat={viewSeat}
          overlay
          handRaise={handRaise}
          highlightCards={frame.stepPlayed !== null && frame.stepPlayed.player === viewSeat ? frame.stepPlayed.cards : []}
        />
      </div>
      {logOpen ? (
        <ActionLogModal
          state={state}
          playedCards={playedCards}
          eraActions={eraActions}
          room={room}
          logStyle={logStyle}
          onClose={() => setLogOpen(false)}
        />
      ) : null}
      {scoreOpen ? (
        <ScoreModal entries={scoreEntries} state={state} room={room} onClose={() => setScoreOpen(false)} />
      ) : null}
      {hintAnchor !== null ? (
        <HintPopup playerCount={pc as 2 | 3 | 4} anchor={hintAnchor} onClose={() => setHintAnchor(null)} />
      ) : null}
      {prefsOpen ? (
        <PrefsModal
          prefs={{ layoutWide: true, handRaise, stackView, logStyle }}
          onChange={(next) => {
            setHandRaise(next.handRaise);
            setStackView(next.stackView);
            setLogStyle(next.logStyle);
            storage?.setItem('brass-hand-raise', next.handRaise);
            storage?.setItem('brass-stack-view', next.stackView);
            storage?.setItem('brass-log-style', next.logStyle);
          }}
          onClose={() => setPrefsOpen(false)}
        />
      ) : null}
    </div>
  );
}
