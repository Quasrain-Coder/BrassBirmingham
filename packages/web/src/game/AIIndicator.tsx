/**
 * AI 思考中指示（M3 Task 5）：store.thinkingSeats 非空时列出正在决策的 AI 座位。
 * 纯渲染组件；座位名为空房间信息时回退 P{seat}。
 */
import type { ReactElement } from 'react';
import type { PlayerIndex } from '@brass/engine';
import type { RoomState } from '@brass/protocol';
import { playerName } from './Panels';

export function AIIndicator({
  room,
  thinkingSeats,
}: {
  room: RoomState | undefined;
  thinkingSeats: readonly PlayerIndex[];
}): ReactElement | null {
  if (thinkingSeats.length === 0) return null;
  return (
    <div className="ai-thinking" data-testid="ai-thinking">
      {thinkingSeats.map((seat) => (
        <span key={seat} className="ai-thinking-seat" data-seat={seat}>
          {playerName(room, seat)} 思考中…
        </span>
      ))}
    </div>
  );
}
