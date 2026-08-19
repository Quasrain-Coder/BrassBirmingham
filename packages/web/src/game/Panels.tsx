/**
 * 信息面板组件（M2 Task 10）：全部纯渲染，直接吃 FilteredState fixture，不连 store。
 * - CoalIronMarket：煤 14 格 / 铁 10 格需求轨（填充态 + 下一块买价，买空显兜底价）
 * - IncomeTrack：各人 incomeSpace→等级 + 现金 + VP
 * - TurnOrderBar：turnOrder 顺序、当前玩家高亮、spentThisRound
 * - HandBar：自己手牌（location 城市名 / industry 产业图标 / wild 角标），他人只显牌数
 * - LogPanel：action_applied 流
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  COAL_FALLBACK_PRICE,
  COAL_MARKET_PRICES,
  INCOME_LEVEL_SPACES,
  IRON_FALLBACK_PRICE,
  IRON_MARKET_PRICES,
  LOCATIONS,
  incomeLevelAt,
} from '@brass/engine';
import type { Action, Card, IndustryType, PlayerIndex } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { INDUSTRY_STYLE } from '../board/BoardSvg';
import type { LogEntry } from './store';

/** 座位显示名：有房间信息用昵称，否则 P{seat}。 */
export function playerName(room: RoomState | undefined, seat: PlayerIndex): string {
  const info = room?.seats.find((s) => s !== null && s.seat === seat);
  return info?.nickname ?? `P${seat}`;
}

/** 城市显示名（未知 id 原样显示）。 */
function locationName(location: string): string {
  return LOCATIONS[location]?.name ?? location;
}

/**
 * 市场格填充语义（engine market.ts）：买从最便宜格起取、卖从最贵空格起填，
 * 故空格集中在低价端——格 i 已填充 ⟺ i >= prices.length - filled。
 */
function marketCells(
  prices: readonly number[],
  filled: number,
  testIdPrefix: string,
): ReactElement[] {
  return prices.map((price, i) => {
    const isFilled = i >= prices.length - filled;
    return (
      <span
        key={`${testIdPrefix}-${i}`}
        className={isFilled ? 'market-cell filled' : 'market-cell'}
        data-price={price}
      >
        £{price}
      </span>
    );
  });
}

/** 下一块买价：最便宜填充格；买空为兜底价。 */
function nextPrice(prices: readonly number[], filled: number, fallback: number): number {
  if (filled <= 0) return fallback;
  return prices[prices.length - filled] ?? fallback;
}

export function CoalIronMarket({ state }: { state: FilteredState }): ReactElement {
  return (
    <section className="coal-iron-market">
      <h3>资源市场</h3>
      <div className="market-row">
        <span className="market-label">煤</span>
        <div className="market-track" data-testid="coal-track">
          {marketCells(COAL_MARKET_PRICES, state.coalMarket, 'coal')}
        </div>
        <span data-testid="coal-next-price">
          下一块 £{nextPrice(COAL_MARKET_PRICES, state.coalMarket, COAL_FALLBACK_PRICE)}
        </span>
      </div>
      <div className="market-row">
        <span className="market-label">铁</span>
        <div className="market-track" data-testid="iron-track">
          {marketCells(IRON_MARKET_PRICES, state.ironMarket, 'iron')}
        </div>
        <span data-testid="iron-next-price">
          下一块 £{nextPrice(IRON_MARKET_PRICES, state.ironMarket, IRON_FALLBACK_PRICE)}
        </span>
      </div>
    </section>
  );
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

export function IncomeTrack({
  state,
  room,
}: {
  state: FilteredState;
  room?: RoomState | undefined;
}): ReactElement {
  return (
    <section className="income-track">
      <h3>收入轨</h3>
      <ul>
        {state.players.map((p, seat) => (
          <li key={seat} data-testid={`income-row-${seat}`}>
            <span className="player-name">{playerName(room, seat)}</span>{' '}
            <AIBadge room={room} seat={seat} />{' '}
            <span>等级{incomeLevelAt(p.incomeSpace)}</span>{' '}
            <span>£{p.money}</span> <span>{p.vp}VP</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 产业中文标签（与 INDUSTRY_STYLE 字母互补，用于板块图可读性）。 */
const INDUSTRY_LABEL: Record<IndustryType, string> = {
  cotton: '棉纺',
  manufacturer: '制造',
  pottery: '陶器',
  coal: '煤矿',
  iron: '铁矿',
  brewery: '酿酒',
};

/**
 * 玩家板块图（修复：对局中查看自己与他人的收入等级、已建板块、面板堆叠升级状态）。
 * - 标题行：昵称 + 收入等级徽章（含 incomeSpace 格位与等级区间）+ 现金 + VP
 * - 已建板块：从 board.slots 聚合本人板块，按产业分组列出（等级 / 翻转 / 收入 / VP / 资源）
 * - 面板堆叠：players[i].tiles 剩余未建板块按等级计数（升级状态）
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

  // 聚合已建板块（board.slots 全部城市 × 槽位，挑出属于本座位的）
  const builtByIndustry = new Map<
    IndustryType,
    { level: number; flipped: boolean; resources: number; incomeAdvance: number }[]
  >();
  for (const slots of Object.values(state.board.slots)) {
    for (const tile of slots) {
      if (tile === null || tile.player !== seat) continue;
      const list = builtByIndustry.get(tile.tile.industry) ?? [];
      list.push({
        level: tile.tile.level,
        flipped: tile.flipped,
        resources: tile.resources,
        incomeAdvance: tile.tile.incomeAdvance,
      });
      builtByIndustry.set(tile.tile.industry, list);
    }
  }
  // 面板堆叠：剩余未建板块按等级计数
  const stackByLevel = new Map<number, number>();
  for (const def of self.tiles) {
    stackByLevel.set(def.level, (stackByLevel.get(def.level) ?? 0) + 1);
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
        <span className="player-name">{playerName(room, seat)}</span>
        <AIBadge room={room} seat={seat} />
        <span className={`level-chip${seat === state.turnOrder[state.currentPlayerIdx] ? ' current' : ''}`}>
          收入等级 {level}
        </span>
        <span className="board-summary">
          {[...builtByIndustry.entries()].length} 类已建 · 面板剩 {self.tiles.length} 块
        </span>
        <span className="board-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="player-board-body">
          <p className="board-meta" data-testid={`player-board-meta-${seat}`}>
            收入格 {self.incomeSpace}（等级 {level} 区间 {levelStart}–{levelEnd}）· 现金 £{self.money} · {self.vp}VP
          </p>
          <div className="board-built" data-testid={`player-board-built-${seat}`}>
            <h4>已建板块</h4>
            {builtByIndustry.size === 0 ? (
              <p className="board-empty">尚未建造</p>
            ) : (
              [...builtByIndustry.entries()].map(([ind, list]) => (
                <div key={ind} className="board-ind">
                  <span className="board-ind-name" style={{ color: INDUSTRY_STYLE[ind].fill }}>
                    {INDUSTRY_LABEL[ind]}
                  </span>
                  <span className="board-ind-list">
                    {list.map((t, i) => (
                      <span
                        key={i}
                        className={`board-tile${t.flipped ? ' flipped' : ''}`}
                        data-testid={`player-board-tile-${seat}-${ind}-${i}`}
                      >
                        Lv{t.level}
                        {t.flipped ? '✓' : '·'}
                        <span className="board-tile-sub">+{t.incomeAdvance}收</span>
                      </span>
                    ))}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="board-stack" data-testid={`player-board-stack-${seat}`}>
            <h4>面板堆叠（未建）</h4>
            {self.tiles.length === 0 ? (
              <p className="board-empty">全部建完</p>
            ) : (
              <span className="board-stack-list">
                {[...stackByLevel.entries()].sort((a, b) => a[0] - b[0]).map(([lv, n]) => (
                  <span key={lv} className="board-stack-item">Lv{lv} ×{n}</span>
                ))}
              </span>
            )}
          </div>
        </div>
      ) : null}
    </section>
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
          const classes = [
            seat === current ? 'current' : '',
            thinking ? 'thinking' : '',
          ]
            .filter((c) => c !== '')
            .join(' ');
          return (
            <li
              key={seat}
              data-player={seat}
              className={classes === '' ? undefined : classes}
            >
              <span className="player-name">{playerName(room, seat)}</span>{' '}
              <AIBadge room={room} seat={seat} />{' '}
              <span>已花 £{player?.spentThisRound ?? 0}</span>
              {thinking ? <span className="thinking-badge"> 思考中…</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** 手牌一句话标签（location 城市名 / industry 产业图标 / wild 标记）。 */
export function cardLabel(card: Card): string {
  switch (card.kind) {
    case 'location':
      return locationName(card.location);
    case 'industry':
      return card.industries.map((ind) => INDUSTRY_STYLE[ind].label).join(' ');
    case 'wild-location':
      return 'Wild 城市';
    case 'wild-industry':
      return 'Wild 产业';
  }
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
                  {cardLabel(card)}
                  {isWild ? <span className="wild-badge">Wild</span> : null}
                </button>
              );
            })
          : null}
      </div>
      <div className="opponent-hands">
        {state.players.map((p, i) =>
          i === seat ? null : (
            <span key={i} data-testid={`opponent-hand-${i}`}>
              {playerName(undefined, i)}：{p.hand.kind === 'count' ? p.hand.count : p.hand.cards.length} 张
            </span>
          ),
        )}
      </div>
    </section>
  );
}

/** 行动一句话摘要（日志用）。 */
export function actionSummary(action: Action): string {
  switch (action.type) {
    case 'build':
      return `建造 ${action.industry} @ ${locationName(action.location)}`;
    case 'network':
      return `连接 ×${action.links.length}`;
    case 'develop':
      return `研发 ${action.removals.join(' + ')}`;
    case 'sell':
      return `出售 ×${action.sales.length}`;
    case 'loan':
      return '贷款';
    case 'scout':
      return '侦察';
    case 'pass':
      return '过';
  }
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
