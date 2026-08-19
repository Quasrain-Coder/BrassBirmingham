/**
 * SVG 棋盘组件（M2 Task 9；视觉翻新 2026-08）。
 * 风格：复古工程图纸（羊皮纸底 + 噪点颗粒 + 双线边框 + 角标装饰），
 * 城市=名称铭牌+节点圆；产业槽位=圆角瓷砖；连接边=带衬线的干线
 * （运河蓝/铁路棕，按当前时代过滤；已建=玩家色粗线+描边）；商人位=六边形。
 *
 * 兼容性：所有既有 data-testid/class/回调契约不变（BoardSvg.test 全量守护）：
 * g.board-location[data-location]、line.board-link[data-link-index]、
 * polygon.board-merchant[data-merchant]、rect.board-slot[data-location][data-slot-index]、
 * .board-link-built/.highlighted、viewBox="-15 -15 1030 790"、运河色 #5dade2。
 */
import type { ReactElement } from 'react';
import type { IndustryType, LocationId, PlayerIndex } from '@brass/engine';
import { LINKS, LINK_EXTRA_ENDPOINTS, LOCATIONS, MERCHANTS } from '@brass/engine';
import type { FilteredState } from '@brass/protocol';
import { LAYOUT } from './layout';

/** 玩家色板：P0 红 / P1 蓝 / P2 黄 / P3 绿。 */
export const PLAYER_COLORS = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71'];

// 运河色与 P1 玩家色（#3498db）拉开区分度（Task 9 评审修复）。
const CANAL_COLOR = '#5dade2';
const RAIL_COLOR = '#8b5a2b';
const INACTIVE_LINK_COLOR = '#d8d8d8';

// 羊皮纸底与墨线色（视觉翻新）。
const PARCHMENT_DARK = '#e2d3ae';
const PARCHMENT_LIGHT = '#f6eed8';
const INK = '#4a3d28';
const INK_SOFT = '#8a7a56';

/** 产业配色与字母标注，全局一致。 */
export const INDUSTRY_STYLE: Record<IndustryType, { fill: string; label: string }> = {
  cotton: { fill: '#5b8dd9', label: 'C' },
  manufacturer: { fill: '#e67e22', label: 'M' },
  pottery: { fill: '#9b59b6', label: 'P' },
  coal: { fill: '#34495e', label: '煤' },
  iron: { fill: '#b03a2e', label: '铁' },
  brewery: { fill: '#d4ac0d', label: '酿' },
};

export interface SlotRef {
  location: LocationId;
  slotIndex: number;
}

/** 高亮集合（Task 11 消费；本任务提供类型与基础渲染支持）。 */
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

const CITY_R = 7;
const SLOT_W = 18;
const SLOT_H = 16;
const SLOT_GAP = 2;
const MERCHANT_R = 13;

function playerColor(player: PlayerIndex): string {
  return PLAYER_COLORS[player] ?? '#7f8c8d';
}

function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  return pts.join(' ');
}

/** 名称铭牌宽度：按字符数粗估（SVG 无文本测量，够用即可）。 */
function namePlateWidth(name: string): number {
  return Math.max(34, name.length * 5.6 + 10);
}

export function BoardSvg({ state, highlights, onSlotClick, onLinkClick }: BoardSvgProps): ReactElement {
  const highlightedLinks = new Set(highlights?.links ?? []);
  const highlightedSlots = new Set(
    (highlights?.slots ?? []).map((s) => `${s.location}:${s.slotIndex}`),
  );
  const builtByLink = new Map<number, PlayerIndex>();
  for (const l of state.board.links) builtByLink.set(l.linkIndex, l.player);

  const linkStroke = (canal: boolean, rail: boolean): string => {
    // 按时代过滤显示：当前时代不可建的边淡灰。
    if (state.era === 'canal') return canal ? CANAL_COLOR : INACTIVE_LINK_COLOR;
    return rail ? RAIL_COLOR : INACTIVE_LINK_COLOR;
  };

  return (
    <svg
      className="board-svg"
      viewBox="-15 -15 1030 790"
      role="img"
      aria-label="Brass: Birmingham 棋盘"
    >
      <defs>
        {/* 羊皮纸噪点颗粒（细密 fractalNoise，低透明度） */}
        <filter id="paper-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.18  0 0 0 0 0.15  0 0 0 0 0.1  0 0 0 0.05 0"
          />
        </filter>
        {/* 节点投影 */}
        <filter id="node-shadow" x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0" dy="1.2" stdDeviation="1.2" floodColor="#3a3226" floodOpacity="0.4" />
        </filter>
        {/* 城市节点径向渐变（羊皮心 → 墨线边） */}
        <radialGradient id="city-grad" cx="0.35" cy="0.3" r="0.85">
          <stop offset="0%" stopColor={PARCHMENT_LIGHT} />
          <stop offset="100%" stopColor={PARCHMENT_DARK} />
        </radialGradient>
      </defs>

      {/* 底图：羊皮纸渐变 + 噪点 + 双线边框 */}
      <rect x={-15} y={-15} width={1030} height={790} fill="url(#city-grad)" />
      <rect x={-15} y={-15} width={1030} height={790} filter="url(#paper-grain)" />
      <rect x={-9} y={-9} width={1018} height={778} fill="none" stroke={INK_SOFT} strokeWidth={1.5} rx={6} />
      <rect x={-5} y={-5} width={1010} height={770} fill="none" stroke={INK} strokeWidth={0.75} rx={4} />
      {/* 四角装饰方块 */}
      {[
        [-15, -15],
        [1015, -15],
        [-15, 775],
        [1015, 775],
      ].map(([cx, cy], i) => (
        <g key={`corner-${i}`} transform={`translate(${cx},${cy})`}>
          <rect x={-7} y={-7} width={14} height={14} fill={PARCHMENT_LIGHT} stroke={INK} strokeWidth={1} />
          <circle r={2.2} fill={INK} />
        </g>
      ))}

      {/* 连接边（先画，垫在城市下面）：衬线 + 干线 + 铁路枕木刻度 */}
      <g className="board-links">
        {LINKS.map((link, i) => {
          const a = LAYOUT[link.a];
          const b = LAYOUT[link.b];
          if (!a || !b) return null;
          const builtBy = builtByLink.get(i);
          const built = builtBy !== undefined;
          const stroke = built ? playerColor(builtBy) : linkStroke(link.canal, link.rail);
          const cls = [
            'board-link',
            built ? 'board-link-built' : '',
            highlightedLinks.has(i) ? 'highlighted' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const extras = LINK_EXTRA_ENDPOINTS[i] ?? [];
          return (
            <g key={`link-${i}`}>
              {/* 衬线：干线描边，定义感 */}
              <line
                className="board-link-casing"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={built ? '#2c2317' : '#efe6d2'}
                strokeWidth={(built ? 5 : 2) + 3}
                strokeLinecap="round"
              />
              <line
                className={cls}
                data-link-index={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={stroke}
                strokeWidth={built ? 5 : highlightedLinks.has(i) ? 4 : 2}
                strokeLinecap="round"
                onClick={onLinkClick ? () => onLinkClick(i) : undefined}
              />
              {/* 铁路枕木刻度（纯装饰，pointer-events 穿透） */}
              {!built && link.rail && state.era === 'rail' ? (
                <line
                  className="board-link-railmarks"
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="#5d4522"
                  strokeWidth={4.5}
                  strokeDasharray="1 7"
                  strokeLinecap="round"
                  pointerEvents="none"
                />
              ) : null}
              {/* 三端点边（#30 同时连接 farm-south）的分支线 */}
              {extras.map((extra) => {
                const e = LAYOUT[extra];
                if (!e) return null;
                const midX = (a.x + b.x) / 2;
                const midY = (a.y + b.y) / 2;
                return (
                  <g key={`link-${i}-${extra}`}>
                    <line
                      className="board-link-casing"
                      x1={midX}
                      y1={midY}
                      x2={e.x}
                      y2={e.y}
                      stroke="#efe6d2"
                      strokeWidth={(built ? 4 : 2) + 3}
                      strokeLinecap="round"
                    />
                    <line
                      className="board-link-branch"
                      data-link-index={i}
                      x1={midX}
                      y1={midY}
                      x2={e.x}
                      y2={e.y}
                      stroke={stroke}
                      strokeWidth={built ? 4 : 2}
                      strokeDasharray={built ? undefined : '4 3'}
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

      {/* 城市：名称铭牌 + 节点圆 + 产业槽位行 */}
      <g className="board-locations">
        {Object.entries(LOCATIONS).map(([id, loc]) => {
          const p = LAYOUT[id];
          if (!p) return null;
          const placed = state.board.slots[id] ?? [];
          const n = loc.slots.length;
          const rowW = n * SLOT_W + (n - 1) * SLOT_GAP;
          const rowX = p.x - rowW / 2;
          const rowY = p.y + CITY_R + 4;
          const plateW = namePlateWidth(loc.name);
          return (
            <g className="board-location" data-location={id} key={id}>
              {/* 名称铭牌 */}
              <rect
                x={p.x - plateW / 2}
                y={p.y - CITY_R - 15}
                width={plateW}
                height={12}
                rx={3}
                fill={PARCHMENT_LIGHT}
                stroke={INK_SOFT}
                strokeWidth={0.75}
              />
              <text
                x={p.x}
                y={p.y - CITY_R - 6}
                textAnchor="middle"
                fontSize={8.5}
                fontFamily="'Special Elite', Georgia, 'Times New Roman', serif"
                fill={INK}
              >
                {loc.name}
              </text>
              {/* 节点圆：投影 + 径向渐变 */}
              <circle
                cx={p.x}
                cy={p.y}
                r={CITY_R}
                fill="url(#city-grad)"
                stroke={INK}
                strokeWidth={1.4}
                filter="url(#node-shadow)"
              />
              <circle cx={p.x} cy={p.y} r={2} fill={INK} />
              {loc.slots.map((slot, si) => {
                const x = rowX + si * (SLOT_W + SLOT_GAP);
                const tile = placed[si] ?? null;
                const hl = highlightedSlots.has(`${id}:${si}`);
                return (
                  <g key={`${id}-slot-${si}`}>
                    <rect
                      className={`board-slot${hl ? ' highlighted' : ''}`}
                      data-location={id}
                      data-slot-index={si}
                      x={x}
                      y={rowY}
                      width={SLOT_W}
                      height={SLOT_H}
                      rx={3}
                      fill={tile ? playerColor(tile.player) : '#fffdf5'}
                      stroke={hl ? '#e91e63' : '#6b5b3e'}
                      strokeWidth={hl ? 2.5 : 1}
                      opacity={tile?.flipped ? 0.55 : 1}
                      onClick={onSlotClick ? () => onSlotClick(id, si) : undefined}
                    />
                    {tile ? (
                      <>
                        <text
                          x={x + SLOT_W / 2}
                          y={rowY + SLOT_H / 2 + 3.5}
                          textAnchor="middle"
                          fontSize={9}
                          fill="#ffffff"
                          pointerEvents="none"
                        >
                          {INDUSTRY_STYLE[tile.tile.industry].label}
                        </text>
                        {/* 资源数角标：煤/铁方块、啤酒桶（sell/network 决策必需） */}
                        {tile.resources > 0 ? (
                          <g className="tile-resources" pointerEvents="none">
                            <circle
                              cx={x + SLOT_W - 3}
                              cy={rowY + SLOT_H - 3}
                              r={4.5}
                              fill="#fffdf5"
                              stroke="#3a3226"
                              strokeWidth={0.8}
                            />
                            <text
                              x={x + SLOT_W - 3}
                              y={rowY + SLOT_H - 0.5}
                              textAnchor="middle"
                              fontSize={7}
                              fill="#3a3226"
                            >
                              {tile.resources}
                            </text>
                          </g>
                        ) : null}
                      </>
                    ) : (
                      slot.industries.map((ind, ii) => {
                        // 空槽位：色块+字母；双产业槽左右各半。
                        const half = slot.industries.length > 1;
                        const cw = half ? (SLOT_W - 4) / 2 : SLOT_W - 4;
                        const cx = x + 2 + ii * cw;
                        const style = INDUSTRY_STYLE[ind];
                        return (
                          <g key={`${id}-slot-${si}-ind-${ii}`} pointerEvents="none">
                            <rect x={cx} y={rowY + 2} width={cw} height={SLOT_H - 4} fill={style.fill} rx={1.5} />
                            <text
                              x={cx + cw / 2}
                              y={rowY + SLOT_H / 2 + 3}
                              textAnchor="middle"
                              fontSize={half ? 7 : 9}
                              fill="#ffffff"
                            >
                              {style.label}
                            </text>
                          </g>
                        );
                      })
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </g>

      {/* 商人位：六边形 + 内圈 + 啤酒数 */}
      <g className="board-merchants">
        {Object.keys(MERCHANTS).map((id) => {
          const p = LAYOUT[id];
          if (!p) return null;
          const m = state.merchants[id as keyof typeof state.merchants];
          return (
            <g className="board-merchant-group" data-merchant={id} key={id}>
              <polygon
                className="board-merchant"
                points={hexPoints(p.x, p.y, MERCHANT_R)}
                fill="#efe1c0"
                stroke="#8a6d3b"
                strokeWidth={1.5}
                filter="url(#node-shadow)"
              />
              <polygon
                points={hexPoints(p.x, p.y, MERCHANT_R - 4)}
                fill="none"
                stroke="#8a6d3b"
                strokeWidth={0.75}
                opacity={0.55}
                pointerEvents="none"
              />
              {m && m.beer > 0 ? (
                <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize={9} fill="#8a6d3b">
                  {`酿×${m.beer}`}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>

      {/* 装饰角：指南针（右上）+ 图例（左下）+ 题铭（右下） */}
      <g className="board-decor" pointerEvents="none">
        {/* 指南针 */}
        <g transform="translate(945,90)">
          <circle r={30} fill={PARCHMENT_LIGHT} stroke={INK_SOFT} strokeWidth={1} />
          <circle r={25} fill="none" stroke={INK_SOFT} strokeWidth={0.5} opacity={0.6} />
          {[0, 45, 90, 135].map((a) => (
            <line
              key={`rose-${a}`}
              x1={0}
              y1={-24}
              x2={0}
              y2={24}
              stroke={INK_SOFT}
              strokeWidth={0.5}
              transform={`rotate(${a})`}
            />
          ))}
          <path d="M0,-20 L5,6 L0,0 L-5,6 Z" fill={INK} />
          <path d="M0,20 L5,-6 L0,0 L-5,-6 Z" fill={INK_SOFT} />
          <text y={42} textAnchor="middle" fontSize={8} fontFamily="'Special Elite', serif" fill={INK_SOFT} letterSpacing={1}>
            N
          </text>
        </g>
        {/* 图例 */}
        <g transform="translate(28,712)">
          <rect x={0} y={0} width={272} height={52} rx={4} fill={PARCHMENT_LIGHT} stroke={INK_SOFT} strokeWidth={1} />
          <text x={10} y={14} fontSize={8.5} fontFamily="'Special Elite', serif" fill={INK} letterSpacing={1.5}>
            图例
          </text>
          <line x1={12} y1={28} x2={52} y2={28} stroke={CANAL_COLOR} strokeWidth={2.5} strokeLinecap="round" />
          <text x={58} y={31} fontSize={8} fill={INK_SOFT}>运河</text>
          <line x1={92} y1={28} x2={132} y2={28} stroke={RAIL_COLOR} strokeWidth={2.5} strokeLinecap="round" />
          <text x={138} y={31} fontSize={8} fill={INK_SOFT}>铁路</text>
          <line x1={172} y1={28} x2={212} y2={28} stroke={PLAYER_COLORS[0]} strokeWidth={4} strokeLinecap="round" />
          <text x={218} y={31} fontSize={8} fill={INK_SOFT}>已建</text>
          <line x1={12} y1={44} x2={52} y2={44} stroke={INACTIVE_LINK_COLOR} strokeWidth={2.5} strokeLinecap="round" />
          <text x={58} y={47} fontSize={8} fill={INK_SOFT}>本时代不可建</text>
        </g>
        {/* 题铭 */}
        <g transform="translate(700,744)">
          <text fontSize={12} fontFamily="'Special Elite', Georgia, serif" fill={INK} letterSpacing={4}>
            BRASS · BIRMINGHAM
          </text>
          <text y={15} fontSize={7.5} fill={INK_SOFT} letterSpacing={2}>
            运河与铁路时代 · 工业英格兰
          </text>
        </g>
      </g>
    </svg>
  );
}
