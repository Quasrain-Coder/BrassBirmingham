/**
 * 对局画面（M2 Task 11 接线）：GameStore → BoardSvg + HandBar + ActionBar + 面板。
 *
 * - 本人回合：legalActions 驱动 useActionDraft；选牌 → 棋盘高亮 → 点目标收集参数 →
 *   ActionBar 确认后 store.submitAction(draft.resolved)（resolved 恒为 legalActions
 *   原对象）。
 * - 非本人回合：棋盘只读（不传点击回调、高亮为空），ActionBar 显示"等待 X 行动"。
 */
import type { ReactElement } from 'react';
import type { Action, PlayerIndex } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { BoardSvg } from '../board/BoardSvg';
import { ActionBar, useActionDraft } from './ActionBar';
import { AIIndicator } from './AIIndicator';
import { HandBar, LogPanel, TurnOrderBar, playerName } from './Panels';
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

  return (
    <div className="game-screen">
      {gameOver !== null ? (
        <p className="game-over" data-testid="game-over">
          对局结束——胜者：{gameOver.winner.map((w) => playerName(room ?? undefined, w)).join('、')}
          （{gameOver.finalScores.join(' / ')} 分）
        </p>
      ) : null}
      <TurnOrderBar state={state} room={room ?? undefined} thinkingSeats={thinkingSeats} />
      <AIIndicator room={room ?? undefined} thinkingSeats={thinkingSeats} />
      <BoardSvg
        state={state}
        highlights={myTurn ? draft.highlights : undefined}
        onSlotClick={myTurn ? draft.clickSlot : undefined}
        onLinkClick={myTurn ? draft.clickLink : undefined}
      />
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
