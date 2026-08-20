/**
 * 信息面板组件（官方素材版，2026-08）。
 * - TurnOrderBar：顺位 + 玩家色点 + AI 徽章 + 已花费（当前玩家高亮，AI 思考呼吸灯）
 * - HandBar：官方卡面图 + 中文名（地点卡=城市，产业卡=产业，百搭角标），他人只显牌数
 * - PlayerBoard：现金（钱币图标）/收入等级/VP + 已建板块与面板堆叠的官方板块缩略图
 * - LogPanel：action_applied 流（中文行动摘要）
 *
 * 煤/铁市场与收入轨已搬上官方版图（BoardSvg），不再有独立侧边栏组件。
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { INCOME_LEVEL_SPACES, TILES, incomeLevelAt } from '@brass/engine';
import type { Action, Card, IndustryType, PlayerIndex } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { INDUSTRY_STYLE, PLAYER_COLORS } from '../board/BoardSvg';
import { cardFaceKey, cardName, describeAction, industryName, locationName } from './display';
import { INDUSTRY_ORDER } from './interactions';
import type { LogEntry } from './store';

/** 座位显示名：有房间信息用昵称，否则 玩家{seat+1}。 */
export function playerName(room: RoomState | undefined, seat: PlayerIndex): string {
  const info = room?.seats.find((s) => s !== null && s.seat === seat);
  return info?.nickname ?? `玩家${seat + 1}`;
}

/** 座位 AI 徽章：房间信息标记 isAI 时渲染（无房间信息或对局外不渲染）。 */
export function AIBadge({
  room,
  seat,
}: {
  room: RoomState | undefined;
  seat: PlayerIndex;
}): ReactElement | null {
  const info = room?.seats.find((s) => s !== null && s.seat === seat);
  if (info === undefined || info === null || !info.isAI) return null;
  return <span className="ai-badge">AI</span>;
}

/** 玩家色点（官方四色，与棋盘板块底色一致）。 */
export function ColorDot({ seat }: { seat: PlayerIndex }): ReactElement {
  return (
    <span
      className="color-dot"
      style={{ background: PLAYER_COLORS[seat] ?? '#7f8c8d' }}
      aria-hidden="true"
    />
  );
}

export function TurnOrderBar({
  state,
  room,
  thinkingSeats,
}: {
  state: FilteredState;
  room?: RoomState | undefined;
  /** ai_thinking 中的座位（M3）：高亮并显示"思考中…"。 */
  thinkingSeats?: readonly PlayerIndex[] | undefined;
}): ReactElement {
  const current = state.turnOrder[state.currentPlayerIdx];
  return (
    <section className="turn-order-bar">
      <h3>行动顺位</h3>
      <ol data-testid="turn-order">
        {state.turnOrder.map((seat) => {
          const player = state.players[seat];
          const thinking = thinkingSeats?.includes(seat) ?? false;
          const classes = [seat === current ? 'current' : '', thinking ? 'thinking' : '']
            .filter((c) => c !== '')
            .join(' ');
          return (
            <li key={seat} data-player={seat} className={classes === '' ? undefined : classes}>
              <ColorDot seat={seat} />
              <span className="player-name">{playerName(room, seat)}</span>{' '}
              <AIBadge room={room} seat={seat} />
              <span className="turn-money">
                <img className="coin-icon" src="/assets/coins/1.png" alt="" />£{player?.money ?? 0}
              </span>
              <span className="turn-vp">{player?.vp ?? 0} 分</span>
              <span>已花 £{player?.spentThisRound ?? 0}</span>
              {thinking ? <span className="thinking-badge"> 思考中…</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * 卡面图路径：一个牌面可能有多张官方美术（fetch-assets 输出 face.png / face@2.png …），
 * 按引擎卡 id 的副本序号轮转，同名牌各副本美术不同（贴近实体牌堆观感）。
 */
const CARD_VARIANTS: Record<string, number> = {
  'ind-brewery': 3,
  'ind-coal': 2,
  'ind-iron': 2,
  'ind-cotton-manufacturer': 3,
};

export function cardImageSrc(card: Card): string {
  const face = cardFaceKey(card);
  const variants = CARD_VARIANTS[face] ?? 1;
  if (variants <= 1) return `/assets/cards/${face}.png`;
  const n = Number(card.id.split('-').pop() ?? '0');
  const pick = (Number.isFinite(n) ? n : 0) % variants;
  return `/assets/cards/${face}${pick === 0 ? '' : `@${pick + 1}`}.png`;
}

export function HandBar({
  state,
  seat,
  selectedCard,
  onSelect,
}: {
  state: FilteredState;
  seat: PlayerIndex;
  selectedCard?: string | null;
  onSelect?: ((cardId: string) => void) | undefined;
}): ReactElement {
  const self = state.players[seat];
  return (
    <section className="hand-bar">
      <h3>手牌</h3>
      <div className="own-hand">
        {self?.hand.kind === 'full'
          ? self.hand.cards.map((card) => {
              const isWild = card.kind === 'wild-location' || card.kind === 'wild-industry';
              const classes = [
                'hand-card',
                isWild ? 'wild' : '',
                selectedCard === card.id ? 'selected' : '',
              ]
                .filter((c) => c !== '')
                .join(' ');
              return (
                <button
                  key={card.id}
                  type="button"
                  data-testid={`hand-card-${card.id}`}
                  className={classes}
                  onClick={() => onSelect?.(card.id)}
                >
                  <img className="hand-card-art" src={cardImageSrc(card)} alt={cardName(card)} />
                  <span className="hand-card-name">{cardName(card)}</span>
                  {isWild ? <span className="wild-badge">百搭</span> : null}
                </button>
              );
            })
          : null}
      </div>
      <div className="opponent-hands">
        {state.players.map((p, i) =>
          i === seat ? null : (
            <span key={i} data-testid={`opponent-hand-${i}`}>
              <ColorDot seat={i} />
              {playerName(undefined, i)}：{p.hand.kind === 'count' ? p.hand.count : p.hand.cards.length} 张
            </span>
          ),
        )}
      </div>
    </section>
  );
}

/**
 * 玩家板块图：现金/收入等级/VP + 已建板块（官方板块缩略图）+ 面板堆叠（未建）。
 * 默认展开本人、折叠他人（点击标题展开/收起）。全部纯渲染，只读 state。
 */
export function PlayerBoard({
  state,
  seat,
  room,
  defaultOpen = false,
}: {
  state: FilteredState;
  seat: PlayerIndex;
  room?: RoomState | undefined;
  /** 初始展开（本人面板传 true，他人折叠）。 */
  defaultOpen?: boolean;
}): ReactElement {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const self = state.players[seat];
  if (self === undefined) return <></>;
  const level = incomeLevelAt(self.incomeSpace);
  const [levelStart, levelEnd] = INCOME_LEVEL_SPACES(level);
  const colorKey = ['purple', 'yellow', 'orange', 'teal'][seat] ?? 'purple';

  // 聚合已建板块（board.slots 全部城市 × 槽位，挑出属于本座位的）
  const builtTiles: { industry: IndustryType; level: number; flipped: boolean; resources: number; location: string }[] = [];
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (const tile of slots) {
      if (tile === null || tile.player !== seat) continue;
      builtTiles.push({
        industry: tile.tile.industry,
        level: tile.tile.level,
        flipped: tile.flipped,
        resources: tile.resources,
        location: loc,
      });
    }
  }
  // 面板堆叠：按原版玩家板展示全部板块（TILES 数值表），每级 = 官方缩略图 + 剩余数 +
  // 翻面得分/收入增加；剩余数从 players[i].tiles 数出（建完置灰）。
  const remainingByTile = new Map<string, number>();
  for (const def of self.tiles) {
    const key = `${def.industry}-${def.level}`;
    remainingByTile.set(key, (remainingByTile.get(key) ?? 0) + 1);
  }

  return (
    <section className="player-board" data-testid={`player-board-${seat}`}>
      <button
        type="button"
        className="player-board-head"
        data-testid={`player-board-toggle-${seat}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ColorDot seat={seat} />
        <span className="player-name">{playerName(room, seat)}</span>
        <AIBadge room={room} seat={seat} />
        <span className={`level-chip${seat === state.turnOrder[state.currentPlayerIdx] ? ' current' : ''}`}>
          收入等级 {level}
        </span>
        <span className="head-money">
          <img className="coin-icon" src="/assets/coins/1.png" alt="" />£{self.money}
        </span>
        <span className="head-vp">{self.vp} 分</span>
        <span className="board-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="player-board-body">
          <p className="board-meta" data-testid={`player-board-meta-${seat}`}>
            收入格 {self.incomeSpace}（等级 {level} 区间 {levelStart}–{levelEnd}）· 现金 £{self.money} · {self.vp} 分
          </p>
          <div className="board-built" data-testid={`player-board-built-${seat}`}>
            <h4>已建板块</h4>
            {builtTiles.length === 0 ? (
              <p className="board-empty">尚未建造</p>
            ) : (
              <div className="board-tile-row">
                {(() => {
                  const perIndustry = new Map<IndustryType, number>();
                  return builtTiles.map((t, i) => {
                    const indIdx = perIndustry.get(t.industry) ?? 0;
                    perIndustry.set(t.industry, indIdx + 1);
                    return (
                      <span
                        key={i}
                        className={`board-tile-thumb${t.flipped ? ' flipped' : ''}`}
                        data-testid={`player-board-tile-${seat}-${t.industry}-${indIdx}`}
                        title={`${industryName(t.industry)} Lv${t.level} @ ${locationName(t.location)}${t.flipped ? '（已翻面）' : ''}`}
                      >
                        <img
                          src={`/assets/tiles/${t.industry}-${t.level}-${colorKey}${t.flipped ? '-back' : ''}.png`}
                          alt={industryName(t.industry)}
                        />
                        <span className="board-tile-sub">Lv{t.level}</span>
                      </span>
                    );
                  });
                })()}
              </div>
            )}
          </div>
          <div className="board-stack" data-testid={`player-board-stack-${seat}`}>
            <h4>面板堆叠（未建）</h4>
            {INDUSTRY_ORDER.map((ind) => (
              <div key={ind} className="board-ind">
                <span className="board-ind-name" style={{ color: INDUSTRY_STYLE[ind].fill }}>
                  {industryName(ind)}
                </span>
                <span className="board-ind-list">
                  {TILES.filter((t) => t.industry === ind).map((def) => {
                    const remaining = remainingByTile.get(`${ind}-${def.level}`) ?? 0;
                    const cost =
                      `£${def.costMoney}` +
                      (def.costCoal > 0 ? ` 煤${def.costCoal}` : '') +
                      (def.costIron > 0 ? ` 铁${def.costIron}` : '');
                    return (
                      <span
                        key={def.level}
                        className={`stack-tile${remaining === 0 ? ' exhausted' : ''}`}
                        data-testid={`player-board-stack-${seat}-${ind}-${def.level}`}
                        title={`${industryName(ind)} Lv${def.level}｜建造成本 ${cost}｜翻面得 ${def.vp} 分、收入 +${def.incomeAdvance} 级`}
                      >
                        <img
                          src={`/assets/tiles/${ind}-${def.level}-${colorKey}.png`}
                          alt={`${industryName(ind)} Lv${def.level}`}
                        />
                        <span className="stack-tile-count">×{remaining}</span>
                        <span className="stack-tile-sub">
                          Lv{def.level}｜翻 {def.vp}分 +{def.incomeAdvance}收
                        </span>
                      </span>
                    );
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** 行动一句话摘要（日志用）：与 ActionBar 确认区共用 display.describeAction。 */
export function actionSummary(action: Action): string {
  return describeAction(action);
}

export function LogPanel({
  log,
  room,
}: {
  log: LogEntry[];
  room?: RoomState | undefined;
}): ReactElement {
  return (
    <section className="log-panel">
      <h3>行动日志</h3>
      {log.length === 0 ? (
        <p data-testid="log-empty">暂无行动</p>
      ) : (
        <ol>
          {log.map((entry) => (
            <li key={entry.seq} data-testid="log-entry">
              #{entry.seq} {playerName(room, entry.player)}：{actionSummary(entry.action)}
              {entry.degraded === true ? (
                <span className="degraded-badge">（已降级）</span>
              ) : null}
              {entry.reason !== undefined ? (
                <blockquote className="log-reason">{entry.reason}</blockquote>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
