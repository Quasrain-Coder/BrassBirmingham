/**
 * 回看模式（导入对局记录后的纯前端逐步回放）：
 * newGame(seed) + 前 N 条行动重放，上一步/下一步/跳首尾，支持换视角座位；
 * 「从此处实战」以当前步数为前缀开新服务器房间（其余座位开放加入）。
 */
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { applyAction, newGame } from '@brass/engine';
import type { PlayerIndex } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import type { RoomState } from '@brass/protocol';
import { BoardSvg } from '../board/BoardSvg';
import { PLAYER_COLORS } from '../board/BoardSvg';
import { PlayerBoard, playerName } from './Panels';
import { useGameStore, type GameStore } from './store';

export function ReviewScreen({ store }: { store: GameStore }): ReactElement {
  const review = useGameStore(store).review;

  const room: RoomState | null = useMemo(() => {
    if (review === null) return null;
    const { record } = review;
    return {
      code: '回放',
      config: { playerCount: record.playerCount, seed: record.seed },
      customSeed: true,
      started: true,
      seats: record.seats.map((s, i) => ({
        seat: i as PlayerIndex,
        nickname: s.nickname,
        isAI: s.isAI,
        connected: true,
      })),
    };
  }, [review]);

  const state = useMemo(() => {
    if (review === null) return null;
    const { record, step, viewSeat } = review;
    let s = newGame(record.playerCount, record.seed);
    for (const { action } of record.actions.slice(0, step)) {
      s = applyAction(s, action);
    }
    return filterStateFor(s, viewSeat);
  }, [review]);

  if (review === null || room === null || state === null) return <></>;
  const { record, step, viewSeat } = review;
  const total = record.actions.length;
  const seats = Array.from({ length: record.playerCount }, (_, i) => i as PlayerIndex);

  return (
    <div className="game-screen review-screen" data-testid="review-screen">
      <header className="game-screen-head">
        <span className="game-room-code">回看模式</span>
        <span className="review-progress" data-testid="review-progress">
          第 {step}/{total} 步 · {state.era === 'canal' ? '运河时代' : '铁路时代'} · 第 {state.round} 轮
          {state.phase === 'game-over' ? ' · 已终局' : ''}
        </span>
        <span className="review-seats">
          视角：
          {seats.map((i) => (
            <button
              key={i}
              type="button"
              className={`btn-ghost${viewSeat === i ? ' review-seat-active' : ''}`}
              data-testid={`review-seat-${i}`}
              onClick={() => store.setReviewSeat(i)}
            >
              <span className="color-dot" style={{ background: PLAYER_COLORS[i] }} />
              {playerName(room, i)}
            </button>
          ))}
        </span>
        <button
          type="button"
          data-testid="review-start-here"
          disabled={state.phase === 'game-over'}
          title={state.phase === 'game-over' ? '终局面不可实战' : '以当前局面为残局开新房间(其余座位开放加入)'}
          onClick={() => store.startFromReview()}
        >
          从此处实战
        </button>
        <button type="button" className="btn-ghost" data-testid="review-close" onClick={() => store.exitReview()}>
          关闭回看
        </button>
      </header>
      <div className="review-body">
        <div className="review-board">
          <BoardSvg state={state} />
        </div>
        <div className="review-panels">
          {seats.map((i) => (
            <PlayerBoard key={i} state={state} seat={i} room={room} compact />
          ))}
        </div>
      </div>
      <div className="review-controls" data-testid="review-controls">
        <button type="button" disabled={step === 0} onClick={() => store.setReviewStep(0)}>
          ⏮ 开头
        </button>
        <button type="button" data-testid="review-prev" disabled={step === 0} onClick={() => store.setReviewStep(step - 1)}>
          ◀ 上一步
        </button>
        <button
          type="button"
          data-testid="review-next"
          disabled={step >= total}
          onClick={() => store.setReviewStep(step + 1)}
        >
          下一步 ▶
        </button>
        <button type="button" disabled={step >= total} onClick={() => store.setReviewStep(total)}>
          末尾 ⏭
        </button>
        <input
          type="range"
          min={0}
          max={total}
          value={step}
          aria-label="回放进度"
          onChange={(e) => store.setReviewStep(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
