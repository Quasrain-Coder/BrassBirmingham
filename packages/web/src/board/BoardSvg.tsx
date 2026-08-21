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
  SLOT_CENTERS,
  SLOT_RECTS,
  SLOT_SIZE,
  TURN_BARRELS,
  TURN_MONEY,
  VP_TRACK,
  locationAnchor,
  merchantAnchor,
} from './geometry';
import type { SlotRect } from './geometry';
import { LOCATION_ZH } from '../game/display';

/** 官方玩家色：P0 紫 / P1 黄 / P2 橙 / P3 青（与官方板块底色一致）。 */
export const PLAYER_COLORS = ['#8e6bb0', '#d9a832', '#c05a30', '#4fa3a5'];
/** 玩家色英文键（素材文件名用）。 */
export const PLAYER_COLOR_KEYS = ['purple', 'yellow', 'orange', 'teal'] as const;

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
  /** 可建城市级高亮（选产业/城市卡时，所有可放置地点的外框）。 */
  locations?: LocationId[];
  /** 啤酒源高亮(match 效果):有余量的自有酒厂地点与有桶商人位。 */
  beerSources?: { locations?: LocationId[]; merchants?: MerchantId[] };
}

/** 行动聚光灯：某玩家刚执行的行动在棋盘上的高亮目标（约 5 秒，GameScreen 驱动）。 */
export interface ActionSpotlight {
  player: PlayerIndex;
  locations: LocationId[];
  links: number[];
}

export interface BoardSvgProps {
  state: FilteredState;
  highlights?: BoardHighlights | undefined;
  spotlight?: ActionSpotlight | null | undefined;
  /** AI 思考中的座位（顺位轨头像呼吸灯）。 */
  thinkingSeats?: readonly PlayerIndex[] | undefined;
  /** 高亮座位(顺位轨头像光圈):跟随播报舞台;缺省按当前行动玩家。 */
  highlightSeat?: PlayerIndex | null | undefined;
  /** 建造预览:非贴合预览 token 盖在目标槽位(确认前,切换城市即跟随)。 */
  buildPreview?: { location: LocationId; slotIndex: number; industry: IndustryType; player: PlayerIndex } | null | undefined;
  /** 啤酒匹配线(resolved 卖货):啤酒来源 → 卖货地点(虚线动效)。 */
  beerMatches?: { from: LocationId | MerchantId; to: LocationId }[] | undefined;
  /** 铺路预览:点选中的连线,暂放一个半透明玩家连接牌(确认前可改选,跟随移动)。 */
  linkPreview?: { links: number[]; player: PlayerIndex; era: 'canal' | 'rail' } | null | undefined;
  onSlotClick?: ((location: LocationId, slotIndex: number) => void) | undefined;
  onLinkClick?: ((linkIndex: number) => void) | undefined;
  /** 点贸易商位(卖出流:选贸易商/切商人桶;顺序约束由 ActionDraft 裁决)。 */
  onMerchantClick?: ((merchant: MerchantId) => void) | undefined;
}

function playerColor(player: PlayerIndex): string {
  return PLAYER_COLORS[player] ?? '#7f8c8d';
}

/**
 * 立起的啤酒桶（替代平贴图,与版图印刷图案区分）：偏黄的桶身 + 椭圆顶面 +
 * 桶箍两道 + 底部投影,营造"立起来"的立体感。
 */
function StandingBeer({ r }: { r: SlotRect }): ReactElement {
  const cx = r.x + r.w / 2;
  const top = r.y + r.h * 0.12;
  const bodyH = r.h * 0.68;
  const rx = r.w * 0.32;
  const ry = r.h * 0.09;
  const bottom = top + bodyH;
  return (
    <g className="board-merchant-beer" pointerEvents="none">
      {/* 底部投影 */}
      <ellipse cx={cx} cy={bottom + ry * 0.7} rx={rx * 1.2} ry={ry} fill="#000" opacity={0.45} />
      {/* 桶身(侧面,到底部椭圆弧) */}
      <path
        d={`M ${cx - rx} ${top} L ${cx - rx} ${bottom} A ${rx} ${ry} 0 0 0 ${cx + rx} ${bottom} L ${cx + rx} ${top} Z`}
        fill="#d99a22"
        stroke="#4a2f08"
        strokeWidth={4}
      />
      {/* 侧面高光 */}
      <rect x={cx - rx * 0.58} y={top + 6} width={rx * 0.3} height={bodyH - 12} rx={6} fill="#f7dc7e" opacity={0.5} />
      {/* 桶箍两道(沿桶身弧度的细弧) */}
      <path
        d={`M ${cx - rx} ${top + bodyH * 0.35} A ${rx} ${ry} 0 0 0 ${cx + rx} ${top + bodyH * 0.35}`}
        fill="none"
        stroke="#4a2f08"
        strokeWidth={3}
      />
      <path
        d={`M ${cx - rx} ${top + bodyH * 0.68} A ${rx} ${ry} 0 0 0 ${cx + rx} ${top + bodyH * 0.68}`}
        fill="none"
        stroke="#4a2f08"
        strokeWidth={3}
      />
      {/* 顶面(亮黄椭圆,立体感的来源) */}
      <ellipse cx={cx} cy={top} rx={rx} ry={ry} fill="#f4c84f" stroke="#4a2f08" strokeWidth={4} />
    </g>
  );
}

/** 版图有效区域（6144 扫描件四边有大片暗边，viewBox 只取版图本体）。 */
const BOARD_VIEW = { x: 990, y: 990, size: 4200 };

function tileImage(industry: IndustryType, level: number, player: PlayerIndex, flipped: boolean): string {
  const color = PLAYER_COLOR_KEYS[player] ?? 'purple';
  return `/assets/tiles/${industry}-${level}-${color}${flipped ? '-back' : ''}.png`;
}

/** 连线渲染几何：回缩端点 ta/tb、路径点串、主方向角（deg，ta→tb）。 */
function linkGeom(
  a: { x: number; y: number },
  b: { x: number; y: number },
  mid: { x: number; y: number } | undefined,
): { m: { x: number; y: number }; pts: string; angle: number } {
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
  const angle = (Math.atan2(tb.y - ta.y, tb.x - ta.x) * 180) / Math.PI;
  return { m, pts: `${ta.x},${ta.y} ${m.x},${m.y} ${tb.x},${tb.y}`, angle };
}

/** 连线路径点：端点锚点 → 投影中点 → 端点锚点（沿印刷运河/铁路）。端点向中点回缩，避免压住槽位。 */
function linkPath(a: { x: number; y: number }, b: { x: number; y: number }, mid: { x: number; y: number } | undefined): string {
  return linkGeom(a, b, mid).pts;
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

/** 已建板块上的资源 token 布局：板块底部两行（最多 6 个），啤酒桶用官方图标。 */
function ResourceTokens({ cx, cy, industry, count }: { cx: number; cy: number; industry: IndustryType; count: number }): ReactElement {
  const perRow = 3;
  const gap = 52;
  const tokens = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const rowCount = Math.min(count - row * perRow, perRow);
    const x = cx + (col - (rowCount - 1) / 2) * gap;
    const y = cy + SLOT_SIZE / 2 - 66 + row * 46;
    tokens.push(
      industry === 'brewery' ? (
        <image key={i} href="/assets/beer.png" x={x - 26} y={y - 26} width={52} height={52} />
      ) : (
        <Cube key={i} x={x} y={y} size={44} fill={industry === 'coal' ? '#1f2329' : '#c76b2a'} />
      ),
    );
  }
  return <g className="tile-resource-tokens">{tokens}</g>;
}

/** 连线 token 尺寸（中点的玩家色连接牌，沿线路方向旋转）。 */
const LINK_TOKEN_W = 190;
const LINK_TOKEN_H = 76;

/** 已建连线：中点放玩家连接牌（实物即玩家色船/车牌），运河=驳船 / 铁路=火车（按建造时时代）。 */
function BuiltLinkToken({ mid, angle, player, era }: { mid: { x: number; y: number }; angle: number; player: PlayerIndex; era: 'canal' | 'rail' }): ReactElement {
  return (
    <g className="link-token" transform={`rotate(${Math.round(angle)} ${mid.x} ${mid.y})`} pointerEvents="none">
      <rect
        x={mid.x - LINK_TOKEN_W / 2}
        y={mid.y - LINK_TOKEN_H / 2}
        width={LINK_TOKEN_W}
        height={LINK_TOKEN_H}
        rx={18}
        fill={playerColor(player)}
        stroke="#14100a"
        strokeWidth={6}
      />
      <image
        href={era === 'canal' ? '/assets/link-canal.png' : '/assets/link-rail.png'}
        x={mid.x - 46}
        y={mid.y - 26}
        width={92}
        height={52}
        preserveAspectRatio="xMidYMid meet"
      />
    </g>
  );
}

export function BoardSvg({ state, highlights, spotlight, highlightSeat, thinkingSeats, buildPreview, beerMatches, linkPreview, onSlotClick, onLinkClick, onMerchantClick }: BoardSvgProps): ReactElement {
  const highlightedLinks = new Set(highlights?.links ?? []);
  const highlightedSlots = new Set((highlights?.slots ?? []).map((s) => `${s.location}:${s.slotIndex}`));
  const highlightedLocations = new Set(highlights?.locations ?? []);
  const beerSourceLocs = new Set(highlights?.beerSources?.locations ?? []);
  const beerSourceMerchants = new Set(highlights?.beerSources?.merchants ?? []);
  const builtByLink = new Map<number, { player: PlayerIndex; era: 'canal' | 'rail' }>();
  for (const l of state.board.links) builtByLink.set(l.linkIndex, { player: l.player, era: l.era });

  const anchorOf = (id: LocationId | MerchantId): { x: number; y: number } =>
    id in MERCHANT_GEOM ? merchantAnchor(id as MerchantId) : locationAnchor(id as LocationId);

  // 市场已填格 = 最贵 filled 格（索引 length-filled .. length-1），见 engine/market.ts。
  const coalFilledFrom = COAL_MARKET_CELLS.length - state.coalMarket;
  const ironFilledFrom = IRON_MARKET_CELLS.length - state.ironMarket;

  // 连线 token 收集后置于所有槽位/板块之上渲染（中点常与槽位重叠，不能被板块图盖住）
  const linkTokens: ReactElement[] = [];
  for (const l of state.board.links) {
    const link = LINKS[l.linkIndex]!;
    const g = linkGeom(anchorOf(link.a), anchorOf(link.b), LINK_MIDPOINTS[l.linkIndex]);
    linkTokens.push(
      <BuiltLinkToken key={`link-token-${l.linkIndex}`} mid={g.m} angle={g.angle} player={l.player} era={l.era} />,
    );
  }

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
              {hl && !built ? (
                <>
                  <polyline
                    className="board-link-hl"
                    points={pts}
                    fill="none"
                    stroke="#f0c964"
                    strokeWidth={16}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.85}
                    filter="url(#hl-glow)"
                    pointerEvents="none"
                  />
                  {/* 中点可点提示牌：让可建目标在板上一眼可见 */}
                  {mid !== undefined ? (
                    <g className="link-hl-chip" pointerEvents="none">
                      <rect
                        x={mid.x - 44}
                        y={mid.y - 44}
                        width={88}
                        height={88}
                        rx={16}
                        fill="#f0c964"
                        opacity={0.9}
                        filter="url(#hl-glow)"
                      />
                      <text x={mid.x} y={mid.y + 20} textAnchor="middle" fontSize={56} fill="#241b0b" fontWeight={700}>
                        +
                      </text>
                    </g>
                  ) : null}
                </>
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
          const rects = SLOT_RECTS[id as LocationId] ?? [];
          const placed = state.board.slots[id as LocationId] ?? [];
          return (
            <g className="board-location" data-location={id} key={id}>
              {/* 可建城市级高亮:选产业/城市卡时外框框出所有可放置地点 */}
              {highlightedLocations.has(id as LocationId) && rects.length > 0
                ? (() => {
                    const pad = 26;
                    const x = Math.min(...rects.map((r) => r.x)) - pad;
                    const y = Math.min(...rects.map((r) => r.y)) - pad;
                    const w = Math.max(...rects.map((r) => r.x + r.w)) - x + pad;
                    const h = Math.max(...rects.map((r) => r.y + r.h)) - y + pad;
                    return (
                      <rect
                        className="board-loc-hl"
                        data-testid={`loc-hl-${id}`}
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        rx={18}
                        fill="none"
                        stroke="#f0c964"
                        strokeWidth={6}
                        filter="url(#hl-glow)"
                        pointerEvents="none"
                      />
                    );
                  })()
                : null}
              {centers.map((c, si) => {
                const tile = placed[si] ?? null;
                const hl = highlightedSlots.has(`${id}:${si}`);
                // 印刷框精确矩形(几何标定);兜底退回中心方块
                const r = rects[si] ?? { x: c.x - SLOT_SIZE / 2, y: c.y - SLOT_SIZE / 2, w: SLOT_SIZE, h: SLOT_SIZE };
                const fresh =
                  tile !== null &&
                  spotlight != null &&
                  tile.player === spotlight.player &&
                  spotlight.locations.includes(id as LocationId);
                return (
                  <g key={`${id}-slot-${si}`}>
                    {tile ? (
                      <g pointerEvents="none">
                        {/* 贴合印刷框;刚放上的(聚光灯窗口内)带一点倾斜+立体感,过后回正 */}
                        <g
                          className={fresh ? 'tile-fresh' : undefined}
                          transform={fresh ? `rotate(3 ${r.x + r.w / 2} ${r.y + r.h / 2})` : undefined}
                        >
                          <image
                            className="board-tile"
                            href={tileImage(tile.tile.industry, tile.tile.level, tile.player, tile.flipped)}
                            x={r.x}
                            y={r.y}
                            width={r.w}
                            height={r.h}
                          />
                        </g>
                        {tile.resources > 0 && !tile.flipped ? (
                          <>
                            <ResourceTokens cx={r.x + r.w / 2} cy={r.y + r.h / 2} industry={tile.tile.industry} count={tile.resources} />
                            <g className="tile-resources">
                              <rect x={r.x + r.w - 62} y={r.y + r.h - 62} width={62} height={62} rx={12} fill="#14100a" opacity={0.85} />
                              <text x={r.x + r.w - 31} y={r.y + r.h - 18} textAnchor="middle" fontSize={40} fill="#f3e9c8">
                                {tile.resources}
                              </text>
                            </g>
                          </>
                        ) : null}
                      </g>
                    ) : null}
                    {hl && !tile ? (
                      <rect
                        className="board-slot-hl"
                        x={r.x}
                        y={r.y}
                        width={r.w}
                        height={r.h}
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
                      x={r.x}
                      y={r.y}
                      width={r.w}
                      height={r.h}
                      fill="transparent"
                      onClick={onSlotClick ? () => onSlotClick(id as LocationId, si) : undefined}
                    />
                  </g>
                );
              })}
              {/* 城市中文铭牌（默认在英文印刷横幅正下方，遮路城侧置——几何校订） */}
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

      {/* 商人位：官方商人板块贴框 + 啤酒桶格(立桶 + 剩余数 token);卖出流可点选 */}
      <g className="board-merchants">
        {(Object.keys(MERCHANTS) as MerchantId[]).map((id) => {
          const geom = MERCHANT_GEOM[id];
          const m = state.merchants[id];
          return (
            <g
              className="board-merchant-group"
              data-merchant={id}
              key={id}
              style={onMerchantClick ? { cursor: 'pointer' } : undefined}
              onClick={onMerchantClick ? () => onMerchantClick(id) : undefined}
            >
              {geom.tiles.map((r, ti) => {
                const type = m?.tiles[ti];
                if (type === undefined) return null;
                return (
                  <image
                    key={`${id}-tile-${ti}`}
                    className="board-merchant-tile"
                    href={`/assets/merchants/${type}.png`}
                    x={r.x}
                    y={r.y}
                    width={r.w}
                    height={r.h}
                  />
                );
              })}
              {geom.beer.map((r, bi) => {
                // 啤酒格:有桶画"立桶"(空的格保持印刷空框);非 blank 板块旁才会放桶
                const filled = bi < (m?.beer ?? 0);
                if (!filled) return null;
                return <StandingBeer key={`${id}-beer-${bi}`} r={r} />;
              })}
              {/* 剩余酒数 token(该商人位总桶数) */}
              {(m?.beer ?? 0) > 0 && geom.beer.length > 0 ? (
                <g className="merchant-beer-count" data-testid={`merchant-beer-${id}`}>
                  <rect
                    x={geom.beer[geom.beer.length - 1]!.x + geom.beer[geom.beer.length - 1]!.w + 8}
                    y={geom.beer[geom.beer.length - 1]!.y + geom.beer[geom.beer.length - 1]!.h / 2 - 26}
                    width={86}
                    height={52}
                    rx={12}
                    fill="#14100a"
                    opacity={0.9}
                  />
                  <text
                    x={geom.beer[geom.beer.length - 1]!.x + geom.beer[geom.beer.length - 1]!.w + 51}
                    y={geom.beer[geom.beer.length - 1]!.y + geom.beer[geom.beer.length - 1]!.h / 2 + 12}
                    textAnchor="middle"
                    fontSize={34}
                    fill="#f3e9c8"
                  >
                    ×{m!.beer}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
      </g>

      {/* 煤/铁市场：已填格叠方块 */}
      <g className="board-markets" pointerEvents="none">
        {COAL_MARKET_CELLS.map((p, i) =>
          i >= coalFilledFrom ? <Cube key={`coal-${i}`} x={p.x} y={p.y} size={MARKET_CELL_SIZE * 0.8} fill="#1f2329" /> : null,
        )}
        {IRON_MARKET_CELLS.map((p, i) =>
          i >= ironFilledFrom ? <Cube key={`iron-${i}`} x={p.x} y={p.y} size={MARKET_CELL_SIZE * 0.8} fill="#c76b2a" /> : null,
        )}
      </g>

      {/* 连线 token 顶层渲染（不被板块图遮挡） */}
      <g className="board-link-tokens">{linkTokens}</g>

      {/* 铺路预览:点选中的连线暂放半透明玩家连接牌(确认前可改选,跟随移动) */}
      {linkPreview !== null && linkPreview !== undefined ? (
        <g className="link-preview" pointerEvents="none" opacity={0.62}>
          {linkPreview.links.map((li) => {
            const link = LINKS[li];
            if (!link) return null;
            const g = linkGeom(anchorOf(link.a), anchorOf(link.b), LINK_MIDPOINTS[li]);
            return (
              <g key={`link-preview-${li}`} data-testid={`link-preview-${li}`}>
                <polyline
                  points={g.pts}
                  fill="none"
                  stroke={playerColor(linkPreview.player)}
                  strokeWidth={12}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <BuiltLinkToken mid={g.m} angle={g.angle} player={linkPreview.player} era={linkPreview.era} />
              </g>
            );
          })}
        </g>
      ) : null}

      {/* 建造预览:确认前把非贴合预览 token 盖在目标槽位(倾斜+半透明) */}
      {buildPreview
        ? (() => {
            const r = SLOT_RECTS[buildPreview.location]?.[buildPreview.slotIndex];
            const def = state.players[buildPreview.player]?.tiles.find(
              (t) => t.industry === buildPreview.industry,
            );
            if (r === undefined || def === undefined) return null;
            const cx = r.x + r.w / 2;
            const cy = r.y + r.h / 2;
            return (
              <g
                className="build-preview"
                data-testid="build-preview"
                pointerEvents="none"
                transform={`rotate(4 ${cx} ${cy})`}
                opacity={0.85}
              >
                <image
                  href={tileImage(buildPreview.industry, def.level, buildPreview.player, false)}
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                />
              </g>
            );
          })()
        : null}

      {/* 啤酒源高亮 + 匹配线(match 效果):有余量的自有酒厂/商人桶金圈,卖货时虚线连到卖货地点 */}
      {beerSourceLocs.size > 0 || beerSourceMerchants.size > 0 ? (
        <g className="beer-sources" pointerEvents="none">
          {Object.entries(SLOT_RECTS).flatMap(([loc, rects]) => {
            if (!beerSourceLocs.has(loc as LocationId)) return [];
            const placed = state.board.slots[loc as LocationId] ?? [];
            return rects.map((r, si) => {
              const t = placed[si];
              if (!t || t.tile.industry !== 'brewery' || t.resources <= 0) return null;
              return (
                <rect
                  key={`beer-src-${loc}-${si}`}
                  className="beer-source-ring"
                  x={r.x - 8}
                  y={r.y - 8}
                  width={r.w + 16}
                  height={r.h + 16}
                  rx={16}
                  fill="none"
                  stroke="#e8c96a"
                  strokeWidth={7}
                />
              );
            });
          })}
          {(Object.keys(MERCHANT_GEOM) as MerchantId[]).map((id) => {
            if (!beerSourceMerchants.has(id)) return null;
            const last = MERCHANT_GEOM[id].beer[MERCHANT_GEOM[id].beer.length - 1];
            if (!last) return null;
            return (
              <rect
                key={`beer-src-m-${id}`}
                className="beer-source-ring"
                x={last.x - 10}
                y={last.y - 10}
                width={last.w + 20}
                height={last.h + 20}
                rx={14}
                fill="none"
                stroke="#e8c96a"
                strokeWidth={7}
              />
            );
          })}
        </g>
      ) : null}
      {beerMatches && beerMatches.length > 0 ? (
        <g className="beer-matches" pointerEvents="none">
          {beerMatches.map((m, i) => {
            const from = anchorOf(m.from);
            const to = anchorOf(m.to);
            return (
              <line
                key={`beer-match-${i}`}
                className="beer-match-line"
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="#e8c96a"
                strokeWidth={10}
                strokeDasharray="26 18"
                strokeLinecap="round"
              />
            );
          })}
        </g>
      ) : null}

      {/* 顺位轨:头像嵌左侧大桶,右侧数字桶上椭圆块放本轮花费(1/5/15 钱币堆) */}
      <g className="board-turn-track" pointerEvents="none">
        <defs>
          {state.turnOrder.map((_seat, rank) => (
            <clipPath key={`turn-clip-${rank}`} id={`turn-clip-${rank}`}>
              <circle cx={TURN_BARRELS[rank]!.x} cy={TURN_BARRELS[rank]!.y} r={105} />
            </clipPath>
          ))}
        </defs>
        {state.turnOrder.map((seat, rank) => {
          const b = TURN_BARRELS[rank]!;
          const m = TURN_MONEY[rank]!;
          const spent = state.players[seat]!.spentThisRound;
          const isCurrent = (highlightSeat ?? state.turnOrder[state.currentPlayerIdx]) === seat;
          const thinking = thinkingSeats?.includes(seat) ?? false;
          const colorKey = PLAYER_COLOR_KEYS[seat] ?? 'purple';
          // 钱币按 15/5/1 面额分解堆叠(最多 5 枚)
          const coins: number[] = [];
          for (let rest = spent; rest > 0 && coins.length < 5; ) {
            const d = rest >= 15 ? 15 : rest >= 5 ? 5 : 1;
            coins.push(d);
            rest -= d;
          }
          return (
            <g
              key={`turn-${seat}`}
              data-turn-seat={seat}
              className={isCurrent ? 'current' : thinking ? 'thinking' : undefined}
            >
              <image
                href={`/assets/players/${colorKey}.png`}
                x={b.x - 105}
                y={b.y - 105}
                width={210}
                height={210}
                clipPath={`url(#turn-clip-${rank})`}
              />
              <circle
                cx={b.x}
                cy={b.y}
                r={105}
                fill="none"
                stroke={playerColor(seat)}
                strokeWidth={8}
              />
              {/* 当前玩家:白色光环画在最外圈,不遮玩家色内圈 */}
              {isCurrent ? (
                <circle
                  className="current-ring"
                  cx={b.x}
                  cy={b.y}
                  r={121}
                  fill="none"
                  stroke="#f5f2e8"
                  strokeWidth={11}
                />
              ) : null}
              {spent > 0 ? (
                <g className="turn-money-oval" data-testid={`turn-spent-${seat}`}>
                  <ellipse cx={m.x} cy={m.y} rx={108} ry={56} fill="#14100a" opacity={0.88} stroke="#8a6d3b" strokeWidth={3} />
                  {coins.map((d, i) => (
                    <image key={i} href={`/assets/coins/${d}.png`} x={m.x - 86 + i * 30} y={m.y - 18} width={36} height={36} />
                  ))}
                  <text
                    x={m.x + 10}
                    y={m.y + 17}
                    textAnchor="middle"
                    fontSize={50}
                    fill="#ff5040"
                    fontWeight={800}
                    stroke="#14100a"
                    strokeWidth={7}
                    paintOrder="stroke"
                  >
                    £{spent}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
      </g>

      {/* 行动聚光灯：刚执行的行动目标高亮（玩家色脉冲，GameScreen 约 5 秒后清除） */}
      {spotlight ? (
        <g className="board-spotlight" pointerEvents="none">
          {spotlight.links.map((i) => {
            const link = LINKS[i];
            if (!link) return null;
            const g = linkGeom(anchorOf(link.a), anchorOf(link.b), LINK_MIDPOINTS[i]);
            return (
              <g
                key={`sp-link-${i}`}
                transform={`rotate(${Math.round(g.angle)} ${g.m.x} ${g.m.y})`}
              >
                <rect
                  className="board-spotlight-pulse"
                  x={g.m.x - LINK_TOKEN_W / 2 - 16}
                  y={g.m.y - LINK_TOKEN_H / 2 - 16}
                  width={LINK_TOKEN_W + 32}
                  height={LINK_TOKEN_H + 32}
                  rx={26}
                  fill="none"
                  stroke={playerColor(spotlight.player)}
                  strokeWidth={12}
                />
              </g>
            );
          })}
          {spotlight.locations.map((loc) => {
            const pts = SLOT_CENTERS[loc] ?? [];
            if (pts.length === 0) return null;
            const pad = 130;
            const xs = pts.map((p) => p.x);
            const ys = pts.map((p) => p.y);
            const x = Math.min(...xs) - pad;
            const y = Math.min(...ys) - pad;
            const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
            const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
            return (
              <rect
                key={`sp-loc-${loc}`}
                className="board-spotlight-pulse"
                x={x}
                y={y}
                width={w}
                height={h}
                rx={36}
                fill="none"
                stroke={playerColor(spotlight.player)}
                strokeWidth={12}
              />
            );
          })}
        </g>
      ) : null}

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
