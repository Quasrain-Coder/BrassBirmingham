/**
 * 对局画面（M2 Task 11 接线）：GameStore → BoardSvg + HandBar + ActionBar + 面板。
 *
 * - 本人回合：legalActions 驱动 useActionDraft；选牌 → 棋盘高亮 → 点目标收集参数 →
 *   ActionBar 确认后 store.submitAction(draft.resolved)（resolved 恒为 legalActions
 *   原对象）。
 * - 非本人回合：棋盘只读（不传点击回调、高亮为空），ActionBar 显示"等待 X 行动"。
 */
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import type { Action, PlayerIndex } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { BoardSvg } from '../board/BoardSvg';
import { PLAYER_COLORS } from '../board/BoardSvg';
import type { ActionSpotlight } from '../board/BoardSvg';
import { ActionBar, useActionDraft } from './ActionBar';
import { AIIndicator } from './AIIndicator';
import { HandBar, LogPanel, PlayerBoard, TurnOrderBar, playerName } from './Panels';
import { describeAction } from './display';
import { SPOTLIGHT_DURATION_MS, spotlightOf } from './spotlight';
import type { GameStore, GameStoreState, LogEntry } from './store';
import { useGameStore } from './store';

interface GameBoardProps {
  store: GameStore;
  state: FilteredState;
  seat: PlayerIndex;
  legalActions: Action[];
  selectedCard: string | null;
  room: RoomState | null;
  log: LogEntry[];
  thinkingSeats: PlayerIndex[];
  gameOver: GameStoreState['gameOver'];
}

/** 非本人回合的固定空数组：避免每渲染新引用触发 useActionDraft 的重置 effect 死循环。 */
const NO_ACTIONS: Action[] = [];

function GameBoard({
  store,
  state,
  seat,
  legalActions,
  selectedCard,
  room,
  log,
  thinkingSeats,
  gameOver,
}: GameBoardProps): ReactElement {
  const current = state.turnOrder[state.currentPlayerIdx] ?? seat;
  const myTurn = current === seat && gameOver === null;
  const selfHand = state.players[seat]?.hand;
  const hand = selfHand?.kind === 'full' ? selfHand.cards : [];
  const draft = useActionDraft({
    legalActions: myTurn ? legalActions : NO_ACTIONS,
    selectedCard: myTurn ? selectedCard : null,
    state,
    seat,
  });

  // 行动聚光灯：最新一条 action_applied → 棋盘高亮 + 横幅，约 5 秒后自动清除；
  // 新行动到达即替换并重置计时（以 seq 为触发键，lastEntry 由 seq 唯一确定）。
  const lastEntry = log[log.length - 1];
  const lastSeq = lastEntry?.seq;
  const [spotlight, setSpotlight] = useState<(ActionSpotlight & { text: string }) | null>(null);
  useEffect(() => {
    if (lastEntry === undefined) return;
    setSpotlight({ ...spotlightOf(lastEntry.player, lastEntry.action), text: describeAction(lastEntry.action) });
    const t = setTimeout(() => setSpotlight(null), SPOTLIGHT_DURATION_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeq]);

  return (
    <div className="game-screen">
      <header className="game-screen-head">
        {room !== null ? (
          <span className="game-room-code" data-testid="game-room-code">
            房间 {room.code}
          </span>
        ) : null}
        <button
          type="button"
          className="btn-ghost"
          data-testid="leave-game"
          onClick={() => store.leaveRoom()}
        >
          离开对局
        </button>
      </header>
      {gameOver !== null ? (
        <p className="game-over" data-testid="game-over">
          对局结束——胜者：{gameOver.winner.map((w) => playerName(room ?? undefined, w)).join('、')}
          （{gameOver.finalScores.join(' / ')} 分）
        </p>
      ) : null}
      <div className="player-boards">
        {state.players.map((_p, i) => (
          <PlayerBoard key={i} state={state} seat={i} room={room ?? undefined} defaultOpen={i === seat} />
        ))}
      </div>
      <AIIndicator room={room ?? undefined} thinkingSeats={thinkingSeats} />
      <div className="board-wrap">
        <BoardSvg
          state={state}
          highlights={myTurn ? draft.highlights : undefined}
          spotlight={spotlight}
          onSlotClick={myTurn ? draft.clickSlot : undefined}
          onLinkClick={myTurn ? draft.clickLink : undefined}
        />
        {spotlight !== null ? (
          <div className="action-spotlight-banner" data-testid="action-spotlight">
            <span
              className="spotlight-dot"
              style={{ background: PLAYER_COLORS[spotlight.player] ?? '#7f8c8d' }}
            />
            {playerName(room ?? undefined, spotlight.player)}：{spotlight.text}
          </div>
        ) : null}
        {/* 行动顺位叠在版图左下角（1-4 名原始轮次 + 本轮花费） */}
        <TurnOrderBar state={state} room={room ?? undefined} thinkingSeats={thinkingSeats} overlay />
      </div>
      <HandBar
        state={state}
        seat={seat}
        selectedCard={selectedCard}
        onSelect={
          myTurn
            ? (id) => store.selectCard(id === selectedCard ? null : id)
            : undefined
        }
      />
      <ActionBar
        myTurn={myTurn}
        waitingFor={playerName(room ?? undefined, current)}
        selectedCard={myTurn ? selectedCard : null}
        hand={hand}
        draft={draft}
        onConfirm={() => {
          if (draft.resolved !== null) store.submitAction(draft.resolved);
        }}
        onCancel={draft.reset}
      />
      <LogPanel log={log} room={room ?? undefined} />
    </div>
  );
}

export function GameScreen({ store }: { store: GameStore }): ReactElement {
  const s = useGameStore(store);
  if (s.snapshot === null || s.seat === null) {
    return (
      <p className="status" data-testid="no-snapshot">
        等待对局快照…
      </p>
    );
  }
  return (
    <GameBoard
      store={store}
      state={s.snapshot}
      seat={s.seat}
      legalActions={s.legalActions}
      selectedCard={s.selectedCard}
      room={s.room}
      log={s.log}
      thinkingSeats={s.thinkingSeats}
      gameOver={s.gameOver}
    />
  );
}
