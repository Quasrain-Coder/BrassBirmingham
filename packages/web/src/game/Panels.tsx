/**
 * 信息面板组件（M2 Task 10）：全部纯渲染，直接吃 FilteredState fixture，不连 store。
 * - CoalIronMarket：煤 14 格 / 铁 10 格需求轨（填充态 + 下一块买价，买空显兜底价）
 * - IncomeTrack：各人 incomeSpace→等级 + 现金 + VP
 * - TurnOrderBar：turnOrder 顺序、当前玩家高亮、spentThisRound
 * - HandBar：自己手牌（location 城市名 / industry 产业图标 / wild 角标），他人只显牌数
 * - LogPanel：action_applied 流
 */
import type { ReactElement } from 'react';
import {
  COAL_FALLBACK_PRICE,
  COAL_MARKET_PRICES,
  IRON_FALLBACK_PRICE,
  IRON_MARKET_PRICES,
  LOCATIONS,
  incomeLevelAt,
} from '@brass/engine';
import type { Action, Card, PlayerIndex } from '@brass/engine';
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

export function IncomeTrack({
  state,
  room,
}: {
  state: FilteredState;
  room?: RoomState;
}): ReactElement {
  return (
    <section className="income-track">
      <h3>收入轨</h3>
      <ul>
        {state.players.map((p, seat) => (
          <li key={seat} data-testid={`income-row-${seat}`}>
            <span className="player-name">{playerName(room, seat)}</span>{' '}
            <span>等级{incomeLevelAt(p.incomeSpace)}</span>{' '}
            <span>£{p.money}</span> <span>{p.vp}VP</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TurnOrderBar({
  state,
  room,
}: {
  state: FilteredState;
  room?: RoomState;
}): ReactElement {
  const current = state.turnOrder[state.currentPlayerIdx];
  return (
    <section className="turn-order-bar">
      <h3>行动顺位</h3>
      <ol data-testid="turn-order">
        {state.turnOrder.map((seat) => {
          const player = state.players[seat];
          return (
            <li
              key={seat}
              data-player={seat}
              className={seat === current ? 'current' : undefined}
            >
              <span className="player-name">{playerName(room, seat)}</span>{' '}
              <span>已花 £{player?.spentThisRound ?? 0}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function cardLabel(card: Card): string {
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
  onSelect?: (cardId: string) => void;
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
  room?: RoomState;
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
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
