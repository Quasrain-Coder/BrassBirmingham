/**
 * 对局画面（M2 Task 11 接线）：GameStore → BoardSvg + HandBar + ActionBar + 面板。
 *
 * - 本人回合：legalActions 驱动 useActionDraft；选牌 → 棋盘高亮 → 点目标收集参数 →
 *   ActionBar 确认后 store.submitAction(draft.resolved)（resolved 恒为 legalActions
 *   原对象）。
 * - 非本人回合：棋盘只读（不传点击回调、高亮为空），ActionBar 显示"等待 X 行动"。
 */
import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Action, Card, PlayerIndex } from '@brass/engine';
import type { DraftPreview, FilteredState, RoomState } from '@brass/protocol';
import { BoardSvg } from '../board/BoardSvg';
import { PLAYER_COLORS } from '../board/BoardSvg';
import type { ActionSpotlight } from '../board/BoardSvg';
import { ActionBar, useActionDraft } from './ActionBar';
import { AIIndicator } from './AIIndicator';
import { DiscardModal } from './DiscardModal';
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
  /** 其他玩家当前的暂存预览(座位 → 预览)。 */
  remoteDrafts: Partial<Record<PlayerIndex, DraftPreview>>;
  /** 最近一次"重置本回合"广播(n 单调递增作触发键)。 */
  resetNotice: { seat: PlayerIndex; n: number } | null;
  /** 各座位本时代已打出的牌(打出记录弹层用)。 */
  playedCards: Card[][];
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
  remoteDrafts,
  resetNotice,
  playedCards,
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

  // 本人暂存预览 → 上行同步给同房其他玩家(幽灵落子 + 暂存播报);清除发 null
  const ownDraft = useMemo<DraftPreview | null>(() => {
    if (!myTurn) return null;
    if (draft.buildPreview !== null) {
      return {
        build: draft.buildPreview,
        text: draft.resolved !== null ? describeAction(draft.resolved) : '建造（待定）',
      };
    }
    if (draft.pickedLinks.length > 0) {
      return {
        links: [...draft.pickedLinks],
        text: `建设连接 ${draft.pickedLinks.length} 条（待定）`,
      };
    }
    if (draft.resolved !== null) {
      const a = draft.resolved;
      if (a.type === 'sell') {
        return {
          sell: {
            tiles: a.sales.map((s) => ({ location: s.location, slotIndex: s.slotIndex })),
            matches: draft.beerMatches,
          },
          text: describeAction(a),
        };
      }
      return { text: describeAction(a) };
    }
    return null;
  }, [myTurn, draft.buildPreview, draft.pickedLinks, draft.resolved, draft.beerMatches]);
  useEffect(() => {
    store.sendDraft(ownDraft);
  }, [store, ownDraft]);

  // 播报舞台：三类播报同一舞台——行动聚光灯(action)/轮次·时代·重置播报(round)/
  // 他人暂存播报(draft)。同一时刻只播一条,每条 5 秒:
  // - action/round:空闲即播,否则排队(串行,不叠加);
  // - draft:立即抢占在播条目——"已暂存就播报,改操作直接替换"(被抢占的在播
  //   条目丢弃,队列不动);确认行动时该玩家的 draft 原位转正为 action。
  type StageItem =
    | (ActionSpotlight & { kind: 'action'; text: string })
    | { kind: 'round'; text: string }
    | { kind: 'draft'; seat: PlayerIndex; text: string };
  const [stage, setStage] = useState<StageItem | null>(null);
  const stageQueueRef = useRef<StageItem[]>([]);
  const stageRef = useRef<StageItem | null>(null);
  const setStageBoth = (item: StageItem | null): void => {
    stageRef.current = item;
    setStage(item);
  };
  const advanceStage = (): void => setStageBoth(stageQueueRef.current.shift() ?? null);
  useEffect(() => {
    if (stage === null) return;
    const t = setTimeout(advanceStage, SPOTLIGHT_DURATION_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);
  const pushStage = (item: StageItem): void => {
    if (stageRef.current === null) setStageBoth(item);
    else stageQueueRef.current.push(item);
  };
  const preemptStage = (item: StageItem): void => setStageBoth(item);
  const clearDraftStage = (draftSeat: PlayerIndex): void => {
    if (stageRef.current?.kind === 'draft' && stageRef.current.seat === draftSeat) advanceStage();
  };

  // 最新一条 action_applied → 行动聚光灯(在播该玩家暂存播报时原位转正,否则排队)
  const lastEntry = log[log.length - 1];
  const lastSeq = lastEntry?.seq;
  useEffect(() => {
    if (lastEntry === undefined) return;
    const item: StageItem = {
      kind: 'action',
      ...spotlightOf(lastEntry.player, lastEntry.action),
      text: describeAction(lastEntry.action),
    };
    if (stageRef.current?.kind === 'draft' && stageRef.current.seat === lastEntry.player) {
      setStageBoth(item);
    } else {
      pushStage(item);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeq]);

  // 新一轮/新时代红字播放入队：round 递增或 era 切换时触发;首帧不播
  const prevRoundRef = useRef<{ era: string; round: number } | null>(null);
  useEffect(() => {
    const prev = prevRoundRef.current;
    prevRoundRef.current = { era: state.era, round: state.round };
    if (prev === null) return;
    if (prev.era !== state.era) {
      pushStage({ kind: 'round', text: '进入铁路时代！' });
    } else if (state.round > prev.round) {
      pushStage({ kind: 'round', text: `第 ${state.round} 轮` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.era, state.round]);

  // 他人暂存(当前行动方非本人时):播报立即抢占/替换;清除时若在播则切下一条
  const remoteDraftSeat = current !== seat ? current : null;
  const remoteDraft = remoteDraftSeat !== null ? remoteDrafts[remoteDraftSeat] : undefined;
  const remoteDraftText = remoteDraft?.text ?? null;
  useEffect(() => {
    if (remoteDraftSeat === null) return;
    if (remoteDraftText === null) {
      clearDraftStage(remoteDraftSeat);
      return;
    }
    preemptStage({ kind: 'draft', seat: remoteDraftSeat, text: remoteDraftText });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteDraftText, remoteDraftSeat]);

  // "X 已重置本回合"全场播报(清其暂存播报后入队)
  useEffect(() => {
    if (resetNotice === null) return;
    clearDraftStage(resetNotice.seat);
    pushStage({
      kind: 'round',
      text: `${playerName(room ?? undefined, resetNotice.seat)} 已重置本回合`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetNotice?.n]);

  const spotlight: (ActionSpotlight & { text: string }) | null =
    stage?.kind === 'action' ? stage : null;
  const roundBanner: string | null = stage?.kind === 'round' ? stage.text : null;
  const draftBanner: { seat: PlayerIndex; text: string } | null =
    stage?.kind === 'draft' ? stage : null;

  // 布局模式:经典 / 宽屏(27 寸全屏,地图居中,左右两列面板全部铺开)
  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  const [layoutWide, setLayoutWideState] = useState<boolean>(() => storage?.getItem('brass-layout') === 'wide');
  const toggleLayout = (): void => {
    const v = !layoutWide;
    setLayoutWideState(v);
    storage?.setItem('brass-layout', v ? 'wide' : 'classic');
  };
  // 打出记录弹层开关
  const [discardOpen, setDiscardOpen] = useState(false);

  // 幽灵落子:本人的暂存优先;非本人回合渲染当前行动方广播来的暂存(如有)
  const ghostBuild =
    myTurn && draft.buildPreview !== null
      ? { ...draft.buildPreview, player: seat }
      : remoteDraft?.build !== undefined
        ? { ...remoteDraft.build, player: current }
        : null;
  const ghostLinks =
    myTurn && draft.pickedLinks.length > 0
      ? { links: draft.pickedLinks, player: seat, era: state.era }
      : remoteDraft?.links !== undefined
        ? { links: remoteDraft.links, player: current, era: state.era }
        : null;
  const ghostBeerMatches = myTurn ? draft.beerMatches : (remoteDraft?.sell?.matches ?? []);

  const boardEl = (
    <div className="board-wrap">
      <BoardSvg
        state={state}
        highlights={myTurn ? draft.highlights : undefined}
        spotlight={spotlight}
        thinkingSeats={thinkingSeats}
        buildPreview={ghostBuild}
        beerMatches={ghostBeerMatches.length > 0 ? ghostBeerMatches : undefined}
        linkPreview={ghostLinks}
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
      {draftBanner !== null ? (
        <div className="action-spotlight-banner draft-banner" data-testid="draft-spotlight">
          <span
            className="spotlight-dot"
            style={{ background: PLAYER_COLORS[draftBanner.seat] ?? '#7f8c8d' }}
          />
          {playerName(room ?? undefined, draftBanner.seat)}：{draftBanner.text}（暂存）
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
          data-testid="open-discard-modal"
          onClick={() => setDiscardOpen(true)}
        >
          打出记录
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
      {discardOpen ? (
        <DiscardModal
          state={state}
          playedCards={playedCards}
          room={room ?? undefined}
          onClose={() => setDiscardOpen(false)}
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
      remoteDrafts={s.remoteDrafts}
      resetNotice={s.resetNotice}
      playedCards={s.playedCards}
    />
  );
}
