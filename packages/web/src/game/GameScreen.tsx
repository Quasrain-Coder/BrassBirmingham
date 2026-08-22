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
import { LOCATIONS } from '@brass/engine';
import type { IndustryType, LocationId } from '@brass/engine';
import type { DraftPreview, FilteredState, RoomState } from '@brass/protocol';
import { BoardSvg, BOARD_VIEW } from '../board/BoardSvg';
import { PLAYER_COLORS } from '../board/BoardSvg';
import type { ActionSpotlight } from '../board/BoardSvg';
import { locationAnchor } from '../board/geometry';
import { ActionBar, useActionDraft } from './ActionBar';
import { AIIndicator } from './AIIndicator';
import { DiscardModal } from './DiscardModal';
import { HandBar, LogModal, LogPanel, PlayerBoard, playerName } from './Panels';
import { TopActionBar } from './TopActionBar';
import { PrefsModal } from './PrefsModal';
import type { HandRaiseMode, StackViewMode } from './PrefsModal';
import type { TopActionKind } from './TopActionBar';
import { describeAction, cardName } from './display';
import { buildabilityFor, reconstructEraLog, resolveBuildSlot } from './interactions';
import { ScoreModal, useScoreHistory } from './ScoreTable';
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
  /** 宽屏面板固定座次(store 持久,断线重连/刷新不重置)。 */
  fixedSeats: PlayerIndex[];
  /** 本回合操作行(宽屏紧凑面板第二行):行动日志/本时代行动/当前 seq。 */
  seq: number;
  /** 其他玩家当前的暂存预览(座位 → 预览)。 */
  remoteDrafts: Partial<Record<PlayerIndex, DraftPreview>>;
  /** 最近一次"重置本回合"广播(n 单调递增作触发键)。 */
  resetNotice: { seat: PlayerIndex; n: number } | null;
  /** 各座位本时代已打出的牌(打出记录弹层用)。 */
  playedCards: Card[][];
  /** 各座位本时代的全部行动及实际现金变化(面板/日志用)。 */
  eraActions: { action: Action; moneyDelta: number }[][];
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
  fixedSeats,
  remoteDrafts,
  resetNotice,
  playedCards,
  eraActions,
}: GameBoardProps): ReactElement {
  const current = state.turnOrder[state.currentPlayerIdx] ?? seat;
  // 上家回合仍被扣住(turnHold)时,即使轮到自己也不能行动——服务端会拒
  // (awaiting-turn-confirm);此时按"等待确认"显示,避免误以为行动被退回
  const myTurn = current === seat && gameOver === null && turnHold === null;
  // 面板按开局座次固定(store 持久);顺位徽标仍按当前轮顺位显示
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
  // 本人面板各产业可建性标注(仅本人回合;他人面板/非本人回合不显示)
  const buildability = useMemo(
    () => (myTurn ? buildabilityFor(state, seat, legalActions) : undefined),
    [myTurn, state, seat, legalActions],
  );
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

  // 播报舞台：两类播报同一舞台串行播放——行动聚光灯(action)/轮次·时代·重置播报(round)。
  // 同一时刻只播一条,每条 5 秒;播报中到达的新条目排队等播完。
  // 注:他人的**暂存**不播报(只在地图上渲染幽灵落子),确认后的行动才播(action);
  // "重置本回合"保留全场播报(round)。
  type StageItem =
    | (ActionSpotlight & { kind: 'action'; text: string })
    | { kind: 'round'; text: string };
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

  // 行动聚光灯：逐条消费日志流(不以"最后一条"为触发键——AI 行动一帧内连发时,
  // React 合并渲染会让中间行动丢播报;每条行动都入队,各播 5 秒)。
  // resetTurn 后序号回退(seq 变小):重置消费水位;store 已剔除被撤销的日志条目。
  const consumedSeqRef = useRef(-1);
  useEffect(() => {
    if (seq < consumedSeqRef.current) consumedSeqRef.current = seq - 1;
    for (const e of log) {
      if (e.seq <= consumedSeqRef.current) continue;
      consumedSeqRef.current = e.seq;
      pushStage({
        kind: 'action',
        ...spotlightOf(e.player, e.action),
        text: describeAction(e.action),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, seq]);

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

  // 行动日志补全:resume 后客户端 log 只有残尾——用 eraActions 按回合结构
  // (运河首轮各 1 动,其余各 2 动,turnOrder 轮转)重建全时代日志,残尾与实时
  // log 对齐合并(AI reason 等字段保留)。
  const displayLog = useMemo<LogEntry[]>(() => {
    const history = reconstructEraLog(state, eraActions);
    if (history.length <= log.length) return log;
    const offset = history.length - log.length;
    return history.map((h, i) => {
      const live = i >= offset ? log[i - offset] : undefined;
      return {
        seq: i,
        player: h.player,
        action: h.action,
        events: live?.events ?? [],
        ...(live?.reason !== undefined ? { reason: live.reason } : {}),
        ...(live?.degraded !== undefined ? { degraded: live.degraded } : {}),
      };
    });
  }, [state, eraActions, log]);

  // 他人暂存(当前行动方非本人时):只取幽灵落子数据,不入播报舞台
  const remoteDraftSeat = current !== seat ? current : null;
  const remoteDraft = remoteDraftSeat !== null ? remoteDrafts[remoteDraftSeat] : undefined;

  // "X 已重置本回合"全场播放入队
  useEffect(() => {
    if (resetNotice === null) return;
    pushStage({
      kind: 'round',
      text: `${playerName(room ?? undefined, resetNotice.seat)} 已重置本回合`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetNotice?.n]);

  const spotlight: (ActionSpotlight & { text: string }) | null =
    stage?.kind === 'action' ? stage : null;
  const roundBanner: string | null = stage?.kind === 'round' ? stage.text : null;

  // 高亮跟随播报:播谁的行动就高亮谁(5 秒全程,直到播完才切换);队列空时回到
  // 实际当前玩家——人类回合于是从思考一直亮到点"结束回合"。面板发光与头像光圈统一。
  const highlightSeat: PlayerIndex = spotlight !== null ? spotlight.player : current;

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
  // 行动日志弹窗开关(宽屏顶部按钮)
  const [logOpen, setLogOpen] = useState(false);
  // 偏好设置弹窗(视图/卡牌悬浮/个人版图风格)
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [handRaise, setHandRaise] = useState<HandRaiseMode>(
    () => (storage?.getItem('brass-hand-raise') as HandRaiseMode | null) ?? 'single',
  );
  const [stackView, setStackView] = useState<StackViewMode>(
    () => (storage?.getItem('brass-stack-view') === 'list' ? 'list' : 'mat'),
  );
  // 宽屏顶部行动栏当前展开的行动类型(选牌变化时收起)
  const [topAction, setTopAction] = useState<TopActionKind>(null);
  useEffect(() => setTopAction(null), [selectedCard]);

  // 拖拽建造/研发(宽屏):从个人版图栈顶拖出板块,落地图城市=建造,落其他区域=研发
  const [dragTile, setDragTile] = useState<{ ind: IndustryType; x: number; y: number; w: number; h: number } | null>(null);
  const boardWrapRef = useRef<HTMLDivElement>(null);
  const selfBoardRef = useRef<HTMLDivElement>(null);
  const handleTileDrop = (ind: IndustryType, x: number, y: number): void => {
    const wrap = boardWrapRef.current;
    if (wrap === null) return;
    // 在自己个人版图内松手 = 什么都没发生(token 回归原位,不触发研发)
    const sb = selfBoardRef.current;
    if (sb !== null) {
      const r = sb.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return;
    }
    const rect = wrap.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      // 落点 → viewBox 坐标 → 最近城市锚点,与按钮流一致(预选产业+点规范化槽位)
      const vx = BOARD_VIEW.x + ((x - rect.left) / rect.width) * BOARD_VIEW.size;
      const vy = BOARD_VIEW.y + ((y - rect.top) / rect.height) * BOARD_VIEW.size;
      let best: { loc: LocationId; dist: number } | null = null;
      for (const loc of Object.keys(LOCATIONS) as LocationId[]) {
        const a = locationAnchor(loc);
        const dist = Math.hypot(a.x - vx, a.y - vy);
        if (best === null || dist < best.dist) best = { loc, dist };
      }
      if (best === null || best.dist > 400) return;
      const loc = best.loc;
      if (
        !draft.candidates.some((a) => a.type === 'build' && a.industry === ind && a.location === loc)
      ) {
        return;
      }
      const def = state.players[seat]?.tiles.find((t) => t.industry === ind);
      if (def === undefined) return;
      const target = resolveBuildSlot(state, seat, loc, ind, def.level);
      if (target === null) return;
      draft.pickIndustry(ind);
      draft.clickSlot(loc, target.slotIndex);
      return;
    }
    // 落到地图外 → 研发(同步选中研发按钮与对应产业)
    if (draft.developChoices.includes(ind)) {
      setTopAction('develop');
      draft.toggleDevelop(ind);
    }
  };
  const onTileDragStart = (ind: IndustryType, e: React.PointerEvent<HTMLElement | SVGElement>): void => {
    if (!myTurn || selectedCard === null) return;
    e.preventDefault();
    // ghost 就用被拖 token 本体(原尺寸,贴在光标正中心),不再用放大的投影
    const rect = (e.target as SVGElement).getBoundingClientRect();
    setDragTile({ ind, x: e.clientX, y: e.clientY, w: rect.width, h: rect.height });
  };
  useEffect(() => {
    if (dragTile === null) return;
    const onMove = (e: PointerEvent): void => {
      setDragTile((d) => (d === null ? null : { ...d, x: e.clientX, y: e.clientY }));
    };
    const onUp = (e: PointerEvent): void => {
      const d = dragTile;
      setDragTile(null);
      handleTileDrop(d.ind, e.clientX, e.clientY);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragTile !== null]);
  const dragDef = dragTile !== null ? state.players[seat]?.tiles.find((t) => t.industry === dragTile.ind) : undefined;

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
    <div className="board-wrap" ref={boardWrapRef}>
      <BoardSvg
        state={state}
        highlights={myTurn ? draft.highlights : undefined}
        spotlight={spotlight}
        highlightSeat={highlightSeat}
        thinkingSeats={thinkingSeats}
        buildPreview={ghostBuild}
        beerMatches={ghostBeerMatches.length > 0 ? ghostBeerMatches : undefined}
        linkPreview={ghostLinks}
        onSlotClick={myTurn ? draft.clickSlot : undefined}
        onLinkClick={myTurn ? draft.clickLink : undefined}
        onMerchantClick={myTurn ? draft.clickMerchant : undefined}
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
      {/* 宽屏:手牌叠在地图下缘,只露牌顶,悬停整张浮出;搜寻模式点手牌=选弃牌 */}
      {layoutWide ? (
        <HandBar
          state={state}
          seat={seat}
          overlay
          selectedCard={selectedCard}
          onSelect={
            myTurn
              ? (id) => store.selectCard(id === selectedCard ? null : id)
              : undefined
          }
          handRaise={handRaise}
          scoutMode={
            myTurn && topAction === 'scout'
              ? { picks: draft.scoutPicks, onToggle: draft.toggleScoutCard }
              : null
          }
        />
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
      {layoutWide ? null : (
      <header className="game-screen-head">
        {room !== null ? (
          <span className="game-room-code" data-testid="game-room-code">
            房间 {room.code}
          </span>
        ) : null}
        <button type="button" className="btn-ghost" data-testid="open-prefs" onClick={() => setPrefsOpen(true)}>
          偏好设置
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
      )}
      {dragTile !== null && dragDef !== undefined ? (
        <img
          className="tile-drag-ghost"
          src={`/assets/tiles/${dragTile.ind}-${dragDef.level}-${['purple', 'yellow', 'orange', 'teal'][seat] ?? 'purple'}.png`}
          alt=""
          style={{
            left: dragTile.x - dragTile.w / 2,
            top: dragTile.y - dragTile.h / 2,
            width: dragTile.w,
            height: dragTile.h,
          }}
        />
      ) : null}
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
      {logOpen ? (
        <LogModal log={displayLog} room={room ?? undefined} onClose={() => setLogOpen(false)} />
      ) : null}
      {prefsOpen ? (
        <PrefsModal
          prefs={{ layoutWide, handRaise, stackView }}
          onChange={(next) => {
            setLayoutWideState(next.layoutWide);
            setHandRaise(next.handRaise);
            setStackView(next.stackView);
            storage?.setItem('brass-layout', next.layoutWide ? 'wide' : 'classic');
            storage?.setItem('brass-hand-raise', next.handRaise);
            storage?.setItem('brass-stack-view', next.stackView);
          }}
          onClose={() => setPrefsOpen(false)}
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
              <div key={i} className="wide-seat" ref={i === seat ? selfBoardRef : undefined}>
                <PlayerBoard state={state} seat={i} room={room ?? undefined} defaultOpen pulse={spotlight?.player === i} activeTurn={highlightSeat === i} compact buildStatus={i === seat ? buildability : undefined} playedCards={playedCards[i] ?? []} eraActions={eraActions[i] ?? []} onTileDragStart={i === seat ? onTileDragStart : undefined} hiddenTopInd={i === seat ? (dragTile?.ind ?? null) : undefined} stackView={stackView} />
              </div>
            ))}
          </aside>
          <div className="wide-center">
            <div className="wide-util-row">
              {room !== null ? (
                <span className="game-room-code" data-testid="game-room-code">房间 {room.code}</span>
              ) : null}
              <span className="top-action-spacer" />
              <button type="button" className="btn-ghost" data-testid="open-prefs" onClick={() => setPrefsOpen(true)}>
                偏好设置
              </button>
              <button type="button" className="btn-ghost" data-testid="open-score-modal" onClick={() => scoreHistory.setOpen(true)}>
                分数构成
              </button>
              <button type="button" className="btn-ghost" data-testid="open-discard-modal" onClick={() => setDiscardOpen(true)}>
                打出记录
              </button>
              <button type="button" className="btn-ghost" data-testid="open-log-modal" onClick={() => setLogOpen(true)}>
                行动日志
              </button>
              <button type="button" className="btn-ghost" data-testid="leave-game" onClick={() => store.leaveRoom()}>
                离开对局
              </button>
            </div>
            <AIIndicator room={room ?? undefined} thinkingSeats={thinkingSeats} />
            <TopActionBar
              myTurn={myTurn}
              waitingFor={playerName(room ?? undefined, turnHold ?? current)}
              selectedCard={myTurn ? selectedCard : null}
              hand={hand}
              draft={draft}
              state={state}
              turnHold={turnHold}
              seat={seat}
              canResetTurn={myTurn && state.actionsThisTurn > 0}
              active={topAction}
              onActiveChange={setTopAction}
              roomCode={room?.code ?? null}
              onToggleLayout={toggleLayout}
              onOpenScore={() => scoreHistory.setOpen(true)}
              onOpenDiscard={() => setDiscardOpen(true)}
              onOpenLog={() => setLogOpen(true)}
              onLeave={() => store.leaveRoom()}
              onConfirm={() => {
                if (draft.resolved !== null) store.submitAction(draft.resolved);
              }}
              onCancel={draft.reset}
              onEndTurn={() => store.endTurn()}
              onResetTurn={() => store.resetTurn()}
            />
            {boardEl}
          </div>
          <aside className="wide-col wide-col-right">
            {fixedSeats.slice(Math.ceil(fixedSeats.length / 2)).map((i) => (
              <div key={i} className="wide-seat" ref={i === seat ? selfBoardRef : undefined}>
                <PlayerBoard state={state} seat={i} room={room ?? undefined} defaultOpen pulse={spotlight?.player === i} activeTurn={highlightSeat === i} compact buildStatus={i === seat ? buildability : undefined} playedCards={playedCards[i] ?? []} eraActions={eraActions[i] ?? []} onTileDragStart={i === seat ? onTileDragStart : undefined} hiddenTopInd={i === seat ? (dragTile?.ind ?? null) : undefined} stackView={stackView} />
              </div>
            ))}
          </aside>
        </div>
      ) : (
        <>
          <div className="player-boards">
            {seatsBefore.map((i) => (
              <PlayerBoard key={i} state={state} seat={i} room={room ?? undefined} defaultOpen={false} pulse={spotlight?.player === i} buildStatus={i === seat ? buildability : undefined} playedCards={playedCards[i] ?? []} />
            ))}
          </div>
          <AIIndicator room={room ?? undefined} thinkingSeats={thinkingSeats} />
          {boardEl}
          {handEl}
          {actionEl}
          <PlayerBoard state={state} seat={seat} room={room ?? undefined} defaultOpen pulse={spotlight?.player === seat} buildStatus={buildability} playedCards={playedCards[seat] ?? []} />
          {seatsAfter.length > 0 ? (
            <div className="player-boards player-boards-after">
              {seatsAfter.map((i) => (
                <PlayerBoard key={i} state={state} seat={i} room={room ?? undefined} defaultOpen={false} pulse={spotlight?.player === i} buildStatus={i === seat ? buildability : undefined} playedCards={playedCards[i] ?? []} />
              ))}
            </div>
          ) : null}
        </>
      )}
      {layoutWide ? null : <LogPanel log={displayLog} room={room ?? undefined} />}
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
      fixedSeats={s.fixedSeats ?? s.snapshot.turnOrder}
      remoteDrafts={s.remoteDrafts}
      resetNotice={s.resetNotice}
      playedCards={s.playedCards}
      eraActions={s.eraActions}
    />
  );
}
