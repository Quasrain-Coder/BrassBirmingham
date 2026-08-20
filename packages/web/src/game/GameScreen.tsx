/**
 * 对局画面（M2 Task 11 接线）：GameStore → BoardSvg + HandBar + ActionBar + 面板。
 *
 * - 本人回合：legalActions 驱动 useActionDraft；选牌 → 棋盘高亮 → 点目标收集参数 →
 *   ActionBar 确认后 store.submitAction(draft.resolved)（resolved 恒为 legalActions
 *   原对象）。
 * - 非本人回合：棋盘只读（不传点击回调、高亮为空），ActionBar 显示"等待 X 行动"。
 */
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Action, PlayerIndex } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { BoardSvg } from '../board/BoardSvg';
import { PLAYER_COLORS } from '../board/BoardSvg';
import type { ActionSpotlight } from '../board/BoardSvg';
import { ActionBar, useActionDraft } from './ActionBar';
import { AIIndicator } from './AIIndicator';
import { HandBar, LogPanel, PlayerBoard, playerName } from './Panels';
import { describeAction } from './display';
import { ScoreModal, useScoreHistory } from './ScoreTable';
import { RoundInfo } from './WideLayout';
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
  turnHold: PlayerIndex | null;
  /** 当前快照 seq(宽屏布局的本回合信息行用)。 */
  seq: number;
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
  turnHold,
  seq,
}: GameBoardProps): ReactElement {
  const current = state.turnOrder[state.currentPlayerIdx] ?? seat;
  const myTurn = current === seat && gameOver === null;
  // 宽屏四个侧列面板按**初始顺位**固定位置(不随每轮顺位重排而换位);
  // 信息行里的顺位徽标仍按当前轮顺位显示。
  const fixedSeatsRef = useRef<PlayerIndex[] | null>(null);
  if (fixedSeatsRef.current === null) fixedSeatsRef.current = [...state.turnOrder];
  const fixedSeats = fixedSeatsRef.current;
  // 面板按本轮顺位排布:顺位在自己之前的排在版图上区,自己锚定在手牌/行动条旁
  // (默认展开),之后的排在自己单元之后——每轮顺位变化时两侧名单随之重排。
  const myPos = state.turnOrder.indexOf(seat);
  const seatsBefore = myPos >= 0 ? state.turnOrder.slice(0, myPos) : [];
  const seatsAfter = myPos >= 0 ? state.turnOrder.slice(myPos + 1) : [];
  const selfHand = state.players[seat]?.hand;
  const hand = selfHand?.kind === 'full' ? selfHand.cards : [];
  const draft = useActionDraft({
    legalActions: myTurn ? legalActions : NO_ACTIONS,
    selectedCard: myTurn ? selectedCard : null,
    state,
    seat,
  });
  // 分数构成:时代切换时自动弹出(手动关闭),头部按钮随时查阅
  const scoreHistory = useScoreHistory(state);

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

  // 新一轮/新时代红字播报（约 5 秒）：round 递增或 era 切换时触发;首帧不播
  const [roundBanner, setRoundBanner] = useState<string | null>(null);
  const prevRoundRef = useRef<{ era: string; round: number } | null>(null);
  useEffect(() => {
    const prev = prevRoundRef.current;
    prevRoundRef.current = { era: state.era, round: state.round };
    if (prev === null) return;
    if (prev.era !== state.era) {
      setRoundBanner('进入铁路时代！');
    } else if (state.round > prev.round) {
      setRoundBanner(`第 ${state.round} 轮`);
    } else {
      return;
    }
    const t = setTimeout(() => setRoundBanner(null), SPOTLIGHT_DURATION_MS);
    return () => clearTimeout(t);
  }, [state.era, state.round]);

  // 布局模式:经典 / 宽屏(27 寸全屏,地图居中,左右两列面板全部铺开)
  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  const [layoutWide, setLayoutWideState] = useState<boolean>(() => storage?.getItem('brass-layout') === 'wide');
  const toggleLayout = (): void => {
    const v = !layoutWide;
    setLayoutWideState(v);
    storage?.setItem('brass-layout', v ? 'wide' : 'classic');
  };

  const boardEl = (
    <div className="board-wrap">
      <BoardSvg
        state={state}
        highlights={myTurn ? draft.highlights : undefined}
        spotlight={spotlight}
        thinkingSeats={thinkingSeats}
        buildPreview={myTurn && draft.buildPreview !== null ? { ...draft.buildPreview, player: seat } : null}
        beerMatches={myTurn ? draft.beerMatches : undefined}
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
      {roundBanner !== null ? (
        <div className="round-banner" data-testid="round-banner">
          {roundBanner}
        </div>
      ) : null}
    </div>
  );
  const handEl = (
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
  );
  const actionEl = (
    <ActionBar
      myTurn={myTurn}
      waitingFor={playerName(room ?? undefined, turnHold ?? current)}
      selectedCard={myTurn ? selectedCard : null}
      hand={hand}
      draft={draft}
      state={state}
      turnHold={turnHold}
      seat={seat}
      canResetTurn={myTurn && state.actionsThisTurn > 0}
      onConfirm={() => {
        if (draft.resolved !== null) store.submitAction(draft.resolved);
      }}
      onCancel={draft.reset}
      onEndTurn={() => store.endTurn()}
      onResetTurn={() => store.resetTurn()}
    />
  );

  return (
    <div className={`game-screen${layoutWide ? ' wide' : ''}`}>
      <header className="game-screen-head">
        {room !== null ? (
          <span className="game-room-code" data-testid="game-room-code">
            房间 {room.code}
          </span>
        ) : null}
        <button type="button" className="btn-ghost" data-testid="toggle-layout" onClick={toggleLayout}>
          {layoutWide ? '经典布局' : '宽屏布局'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          data-testid="open-score-modal"
          onClick={() => scoreHistory.setOpen(true)}
        >
          分数构成
        </button>
        <button
          type="button"
          className="btn-ghost"
          data-testid="leave-game"
          onClick={() => store.leaveRoom()}
        >
          离开对局
        </button>
      </header>
      {scoreHistory.open ? (
        <ScoreModal
          entries={scoreHistory.entries}
          state={state}
          room={room}
          onClose={() => scoreHistory.setOpen(false)}
        />
      ) : null}
      {gameOver !== null ? (
        <p className="game-over" data-testid="game-over">
          对局结束——胜者：{gameOver.winner.map((w) => playerName(room ?? undefined, w)).join('、')}
          （{gameOver.finalScores.join(' / ')} 分）
        </p>
      ) : null}
      {layoutWide ? (
        <div className="wide-grid">
          <aside className="wide-col wide-col-left">
            {fixedSeats.slice(0, Math.ceil(fixedSeats.length / 2)).map((i) => (
              <div key={i} className="wide-seat">
                <PlayerBoard state={state} seat={i} room={room ?? undefined} defaultOpen pulse={spotlight?.player === i} activeTurn={current === i} compact />
                <RoundInfo state={state} seat={i} seq={seq} log={log} room={room} />
              </div>
            ))}
          </aside>
          <div className="wide-center">
            <AIIndicator room={room ?? undefined} thinkingSeats={thinkingSeats} />
            {boardEl}
            {handEl}
            {actionEl}
          </div>
          <aside className="wide-col wide-col-right">
            {fixedSeats.slice(Math.ceil(fixedSeats.length / 2)).map((i) => (
              <div key={i} className="wide-seat">
                <PlayerBoard state={state} seat={i} room={room ?? undefined} defaultOpen pulse={spotlight?.player === i} activeTurn={current === i} compact />
                <RoundInfo state={state} seat={i} seq={seq} log={log} room={room} />
              </div>
            ))}
          </aside>
>>>>>>> 15d0f84 (feat(web): 宽屏布局模式——地图居中,左右两列面板铺开 + 本回合信息行)
        </div>
      ) : (
        <>
          <div className="player-boards">
            {seatsBefore.map((i) => (
              <PlayerBoard key={i} state={state} seat={i} room={room ?? undefined} defaultOpen={false} pulse={spotlight?.player === i} />
            ))}
          </div>
          <AIIndicator room={room ?? undefined} thinkingSeats={thinkingSeats} />
          {boardEl}
          {handEl}
          {actionEl}
          <PlayerBoard state={state} seat={seat} room={room ?? undefined} defaultOpen pulse={spotlight?.player === seat} />
          {seatsAfter.length > 0 ? (
            <div className="player-boards player-boards-after">
              {seatsAfter.map((i) => (
                <PlayerBoard key={i} state={state} seat={i} room={room ?? undefined} defaultOpen={false} pulse={spotlight?.player === i} />
              ))}
            </div>
          ) : null}
        </>
      )}
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
      turnHold={s.turnHold}
      seq={s.seq}
    />
  );
}
