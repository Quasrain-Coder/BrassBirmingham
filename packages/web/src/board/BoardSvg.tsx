/**
 * SVG 棋盘组件（官方版图版，2026-08 素材化重做）。
 *
 * 底图 = 官方版图扫描（/assets/board.jpg，6144 坐标系，几何见 board/geometry.ts）；
 * 动态层全部叠加在印刷元素上：
 * - 已建产业 = 官方板块图（产业-等级-玩家色，翻面用背面图），资源数叠图标角标；
 * - 已建连接 = 沿印刷运河/铁路折线的玩家色描边；
 * - 商人位 = 官方商人板块图 + 啤酒桶；煤/铁市场 = 印刷格上叠方块；
 * - VP/收入 = 环轨上的玩家色标记；城市名 = 中文铭牌覆盖英文印刷名；
 * - 可选中槽位/连线 = 黄铜色发光高亮（点击热区为透明 rect/line，契约见测试）。
 *
 * 交互契约（BoardSvg.test 守护）：
 * g.board-location[data-location]、rect.board-slot[data-location][data-slot-index]、
 * line.board-link[data-link-index]（含 .board-link-built/.highlighted）、
 * g.board-merchant-group[data-merchant]、.tile-resources。
 */
import type { ReactElement } from 'react';
import type { IndustryType, LocationId, MerchantId, PlayerIndex } from '@brass/engine';
import { LINKS, LINK_EXTRA_ENDPOINTS, LOCATIONS, MERCHANTS, incomeLevelAt } from '@brass/engine';
import type { FilteredState } from '@brass/protocol';
import {
  BOARD_SIZE,
  CITY_LABEL,
  COAL_MARKET_CELLS,
  INCOME_TRACK,
  IRON_MARKET_CELLS,
  LINK_MIDPOINTS,
  MARKET_CELL_SIZE,
  MERCHANT_GEOM,
  MERCHANT_TILE_H,
  MERCHANT_TILE_W,
  SLOT_CENTERS,
  SLOT_SIZE,
  VP_TRACK,
  locationAnchor,
  merchantAnchor,
} from './geometry';
import { LOCATION_ZH } from '../game/display';

/** 官方玩家色：P0 紫 / P1 黄 / P2 橙 / P3 青（与官方板块底色一致）。 */
export const PLAYER_COLORS = ['#8e6bb0', '#d9a832', '#c05a30', '#4fa3a5'];
/** 玩家色英文键（素材文件名用）。 */
const PLAYER_COLOR_KEYS = ['purple', 'yellow', 'orange', 'teal'] as const;

/** 产业配色与中文标注（面板/行动描述共用）。 */
export const INDUSTRY_STYLE: Record<IndustryType, { fill: string; label: string }> = {
  cotton: { fill: '#b8524a', label: '棉' },
  manufacturer: { fill: '#c78a3b', label: '造' },
  pottery: { fill: '#a0558f', label: '陶' },
  coal: { fill: '#3a3f4a', label: '煤' },
  iron: { fill: '#c76b2a', label: '铁' },
  brewery: { fill: '#8f7a3a', label: '酿' },
};

export interface SlotRef {
  location: LocationId;
  slotIndex: number;
}

export interface BoardHighlights {
  slots?: SlotRef[];
  links?: number[];
}

export interface BoardSvgProps {
  state: FilteredState;
  highlights?: BoardHighlights | undefined;
  onSlotClick?: ((location: LocationId, slotIndex: number) => void) | undefined;
  onLinkClick?: ((linkIndex: number) => void) | undefined;
}

function playerColor(player: PlayerIndex): string {
  return PLAYER_COLORS[player] ?? '#7f8c8d';
}

/** 版图有效区域（6144 扫描件四边有大片暗边，viewBox 只取版图本体）。 */
const BOARD_VIEW = { x: 990, y: 990, size: 4200 };

function tileImage(industry: IndustryType, level: number, player: PlayerIndex, flipped: boolean): string {
  const color = PLAYER_COLOR_KEYS[player] ?? 'purple';
  return `/assets/tiles/${industry}-${level}-${color}${flipped ? '-back' : ''}.png`;
}

/** 连线路径点：端点锚点 → 投影中点 → 端点锚点（沿印刷运河/铁路）。端点向中点回缩，避免压住槽位。 */
function linkPath(a: { x: number; y: number }, b: { x: number; y: number }, mid: { x: number; y: number } | undefined): string {
  const m = mid ?? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const trim = (p: { x: number; y: number }): { x: number; y: number } => {
    const dx = m.x - p.x;
    const dy = m.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const t = Math.min(150, len * 0.4) / len;
    return { x: Math.round(p.x + dx * t), y: Math.round(p.y + dy * t) };
  };
  const ta = trim(a);
  const tb = trim(b);
  return `${ta.x},${ta.y} ${m.x},${m.y} ${tb.x},${tb.y}`;
}

/** 煤/铁方块（官方即纯色木方块，圆角+顶面高光）。 */
function Cube({ x, y, size, fill }: { x: number; y: number; size: number; fill: string }): ReactElement {
  return (
    <g>
      <rect x={x - size / 2} y={y - size / 2} width={size} height={size} rx={size * 0.12} fill={fill} stroke="#1a1208" strokeWidth={size * 0.06} />
      <rect x={x - size / 2 + size * 0.12} y={y - size / 2 + size * 0.1} width={size * 0.76} height={size * 0.28} rx={size * 0.08} fill="#ffffff" opacity={0.3} />
    </g>
  );
}

export function BoardSvg({ state, highlights, onSlotClick, onLinkClick }: BoardSvgProps): ReactElement {
  const highlightedLinks = new Set(highlights?.links ?? []);
  const highlightedSlots = new Set((highlights?.slots ?? []).map((s) => `${s.location}:${s.slotIndex}`));
  const builtByLink = new Map<number, PlayerIndex>();
  for (const l of state.board.links) builtByLink.set(l.linkIndex, l.player);

  const anchorOf = (id: LocationId | MerchantId): { x: number; y: number } =>
    id in MERCHANT_GEOM ? merchantAnchor(id as MerchantId) : locationAnchor(id as LocationId);

  // 市场已填格 = 最贵 filled 格（索引 length-filled .. length-1），见 engine/market.ts。
  const coalFilledFrom = COAL_MARKET_CELLS.length - state.coalMarket;
  const ironFilledFrom = IRON_MARKET_CELLS.length - state.ironMarket;

  return (
    <svg
      className="board-svg"
      viewBox={`${BOARD_VIEW.x} ${BOARD_VIEW.y} ${BOARD_VIEW.size} ${BOARD_VIEW.size}`}
      role="img"
      aria-label="Brass: Birmingham 棋盘"
    >
      <defs>
        <filter id="hl-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx={0} dy={0} stdDeviation={18} floodColor="#f0c964" floodOpacity={0.95} />
        </filter>
      </defs>

      {/* 官方版图底图 */}
      <image className="board-image" href="/assets/board.jpg" x={0} y={0} width={BOARD_SIZE} height={BOARD_SIZE} />

      {/* 已建连接（玩家色描边，沿印刷路径）+ 连线点击热区 */}
      <g className="board-links">
        {LINKS.map((link, i) => {
          const a = anchorOf(link.a);
          const b = anchorOf(link.b);
          const mid = LINK_MIDPOINTS[i];
          const builtBy = builtByLink.get(i);
          const built = builtBy !== undefined;
          const hl = highlightedLinks.has(i);
          const cls = ['board-link', built ? 'board-link-built' : '', hl ? 'highlighted' : ''].filter(Boolean).join(' ');
          const pts = linkPath(a, b, mid);
          const extras = LINK_EXTRA_ENDPOINTS[i] ?? [];
          return (
            <g key={`link-${i}`}>
              {built ? (
                <polyline
                  className="board-link-visual"
                  points={pts}
                  fill="none"
                  stroke={playerColor(builtBy)}
                  strokeWidth={46}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.92}
                  pointerEvents="none"
                />
              ) : null}
              {hl && !built ? (
                <polyline
                  className="board-link-hl"
                  points={pts}
                  fill="none"
                  stroke="#f0c964"
                  strokeWidth={40}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.75}
                  filter="url(#hl-glow)"
                  pointerEvents="none"
                />
              ) : null}
              {/* 透明粗热区（保留 data-link-index 契约） */}
              <line
                className={cls}
                data-link-index={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="transparent"
                strokeWidth={160}
                strokeLinecap="round"
                onClick={onLinkClick ? () => onLinkClick(i) : undefined}
              />
              {extras.map((extra) => {
                const e = anchorOf(extra);
                const m = mid ?? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                return (
                  <g key={`link-${i}-${extra}`}>
                    {built ? (
                      <polyline
                        className="board-link-visual"
                        points={`${m.x},${m.y} ${e.x},${e.y}`}
                        fill="none"
                        stroke={playerColor(builtBy)}
                        strokeWidth={46}
                        strokeLinecap="round"
                        opacity={0.92}
                        pointerEvents="none"
                      />
                    ) : null}
                    <line
                      className="board-link-branch"
                      data-link-index={i}
                      x1={m.x}
                      y1={m.y}
                      x2={e.x}
                      y2={e.y}
                      stroke="transparent"
                      strokeWidth={140}
                      strokeLinecap="round"
                      onClick={onLinkClick ? () => onLinkClick(i) : undefined}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
      </g>

      {/* 产业槽位：已建板块图 + 资源角标 + 高亮/点击热区 */}
      <g className="board-locations">
        {Object.entries(LOCATIONS).map(([id]) => {
          const centers = SLOT_CENTERS[id as LocationId] ?? [];
          const placed = state.board.slots[id as LocationId] ?? [];
          return (
            <g className="board-location" data-location={id} key={id}>
              {centers.map((c, si) => {
                const tile = placed[si] ?? null;
                const hl = highlightedSlots.has(`${id}:${si}`);
                return (
                  <g key={`${id}-slot-${si}`}>
                    {tile ? (
                      <g pointerEvents="none">
                        <image
                          className="board-tile"
                          href={tileImage(tile.tile.industry, tile.tile.level, tile.player, tile.flipped)}
                          x={c.x - SLOT_SIZE / 2}
                          y={c.y - SLOT_SIZE / 2}
                          width={SLOT_SIZE}
                          height={SLOT_SIZE}
                        />
                        {tile.resources > 0 ? (
                          <g className="tile-resources">
                            <rect x={c.x + SLOT_SIZE / 2 - 62} y={c.y + SLOT_SIZE / 2 - 62} width={62} height={62} rx={12} fill="#14100a" opacity={0.85} />
                            <text x={c.x + SLOT_SIZE / 2 - 31} y={c.y + SLOT_SIZE / 2 - 18} textAnchor="middle" fontSize={40} fill="#f3e9c8">
                              {tile.resources}
                            </text>
                          </g>
                        ) : null}
                      </g>
                    ) : null}
                    {hl && !tile ? (
                      <rect
                        className="board-slot-hl"
                        x={c.x - SLOT_SIZE / 2}
                        y={c.y - SLOT_SIZE / 2}
                        width={SLOT_SIZE}
                        height={SLOT_SIZE}
                        rx={16}
                        fill="#f0c964"
                        opacity={0.4}
                        stroke="#f0c964"
                        strokeWidth={10}
                        filter="url(#hl-glow)"
                        pointerEvents="none"
                      />
                    ) : null}
                    <rect
                      className={`board-slot${hl ? ' highlighted' : ''}`}
                      data-location={id}
                      data-slot-index={si}
                      x={c.x - SLOT_SIZE / 2}
                      y={c.y - SLOT_SIZE / 2}
                      width={SLOT_SIZE}
                      height={SLOT_SIZE}
                      fill="transparent"
                      onClick={onSlotClick ? () => onSlotClick(id as LocationId, si) : undefined}
                    />
                  </g>
                );
              })}
              {/* 城市中文铭牌（盖住英文印刷名） */}
              {CITY_LABEL[id as LocationId] ? (
                <g className="city-label" pointerEvents="none">
                  {(() => {
                    const name = LOCATION_ZH[id] ?? LOCATIONS[id as LocationId]?.name ?? id;
                    const lp = CITY_LABEL[id as LocationId]!;
                    const w = name.length * 50 + 40;
                    return (
                      <>
                        <rect
                          x={lp.x - w / 2}
                          y={lp.y - 34}
                          width={w}
                          height={68}
                          rx={10}
                          fill="#14100a"
                          opacity={0.82}
                          stroke="#8a6d3b"
                          strokeWidth={2}
                        />
                        <text
                          x={lp.x}
                          y={lp.y + 16}
                          textAnchor="middle"
                          fontSize={44}
                          fill="#f0d89a"
                          fontFamily="'Songti SC', 'Noto Serif SC', serif"
                        >
                          {name}
                        </text>
                      </>
                    );
                  })()}
                </g>
              ) : null}
            </g>
          );
        })}
      </g>

      {/* 商人位：官方商人板块 + 啤酒桶 */}
      <g className="board-merchants">
        {(Object.keys(MERCHANTS) as MerchantId[]).map((id) => {
          const geom = MERCHANT_GEOM[id];
          const m = state.merchants[id];
          return (
            <g className="board-merchant-group" data-merchant={id} key={id}>
              {geom.tiles.map((p, ti) => {
                const type = m?.tiles[ti];
                if (type === undefined) return null;
                return (
                  <image
                    key={`${id}-tile-${ti}`}
                    className="board-merchant-tile"
                    href={`/assets/merchants/${type}.png`}
                    x={p.x - MERCHANT_TILE_W / 2}
                    y={p.y - MERCHANT_TILE_H / 2}
                    width={MERCHANT_TILE_W}
                    height={MERCHANT_TILE_H}
                  />
                );
              })}
              {geom.beer.slice(0, m?.beer ?? 0).map((p, bi) => (
                <image
                  key={`${id}-beer-${bi}`}
                  className="board-merchant-beer"
                  href="/assets/beer.png"
                  x={p.x - 55}
                  y={p.y - 55}
                  width={110}
                  height={110}
                />
              ))}
            </g>
          );
        })}
      </g>

      {/* 煤/铁市场：已填格叠方块 */}
      <g className="board-markets" pointerEvents="none">
        {COAL_MARKET_CELLS.map((p, i) =>
          i >= coalFilledFrom ? <Cube key={`coal-${i}`} x={p.x} y={p.y} size={MARKET_CELL_SIZE * 0.8} fill="#454c58" /> : null,
        )}
        {IRON_MARKET_CELLS.map((p, i) =>
          i >= ironFilledFrom ? <Cube key={`iron-${i}`} x={p.x} y={p.y} size={MARKET_CELL_SIZE * 0.8} fill="#c76b2a" /> : null,
        )}
      </g>

      {/* VP / 收入轨玩家标记 */}
      <g className="board-tracks" pointerEvents="none">
        {state.players.map((p, i) => {
          const vp = VP_TRACK[p.vp % 100]!;
          const inc = INCOME_TRACK[Math.max(0, Math.min(99, p.incomeSpace))]!;
          const dx = (i - 1.5) * 30;
          return (
            <g key={`track-${i}`}>
              <circle cx={vp.x + dx} cy={vp.y} r={34} fill={playerColor(i)} stroke="#14100a" strokeWidth={6} />
              <circle cx={inc.x + dx * 0.6} cy={inc.y} r={24} fill={playerColor(i)} stroke="#f3e9c8" strokeWidth={5} />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/** 收入等级（供面板显示用，避免各处重复引入 engine helper）。 */
export { incomeLevelAt };
