/**
 * SVG 棋盘组件（M2 Task 9）。自绘简化风，不复制原版美术：
 * 城市=圆点+名称文本；产业槽位=城市旁小矩形（色块+产业字母）；
 * 连接边=线（运河蓝/铁路棕，按当前时代过滤；已建=玩家色粗线）；商人位=六边形。
 */
import type { ReactElement } from 'react';
import type { IndustryType, LocationId, PlayerIndex } from '@brass/engine';
import { LINKS, LINK_EXTRA_ENDPOINTS, LOCATIONS, MERCHANTS } from '@brass/engine';
import type { FilteredState } from '@brass/protocol';
import { BOARD_HEIGHT, BOARD_WIDTH, LAYOUT } from './layout';

/** 玩家色板：P0 红 / P1 蓝 / P2 黄 / P3 绿。 */
export const PLAYER_COLORS = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71'];

const CANAL_COLOR = '#3498db';
const RAIL_COLOR = '#8b5a2b';
const INACTIVE_LINK_COLOR = '#d8d8d8';

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
  highlights?: BoardHighlights;
  onSlotClick?: (location: LocationId, slotIndex: number) => void;
  onLinkClick?: (linkIndex: number) => void;
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
      viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`}
      role="img"
      aria-label="Brass: Birmingham 棋盘"
    >
      {/* 连接边（先画，垫在城市下面） */}
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
              {/* 三端点边（#30 同时连接 farm-south）的分支线 */}
              {extras.map((extra) => {
                const e = LAYOUT[extra];
                if (!e) return null;
                return (
                  <line
                    key={`link-${i}-${extra}`}
                    className="board-link-branch"
                    data-link-index={i}
                    x1={(a.x + b.x) / 2}
                    y1={(a.y + b.y) / 2}
                    x2={e.x}
                    y2={e.y}
                    stroke={stroke}
                    strokeWidth={built ? 4 : 2}
                    strokeDasharray={built ? undefined : '4 3'}
                    strokeLinecap="round"
                  />
                );
              })}
            </g>
          );
        })}
      </g>

      {/* 城市：圆点 + 名称 + 产业槽位行 */}
      <g className="board-locations">
        {Object.entries(LOCATIONS).map(([id, loc]) => {
          const p = LAYOUT[id];
          if (!p) return null;
          const placed = state.board.slots[id] ?? [];
          const n = loc.slots.length;
          const rowW = n * SLOT_W + (n - 1) * SLOT_GAP;
          const rowX = p.x - rowW / 2;
          const rowY = p.y + CITY_R + 3;
          return (
            <g className="board-location" data-location={id} key={id}>
              <circle cx={p.x} cy={p.y} r={CITY_R} fill="#f5e6c8" stroke="#6b5b3e" strokeWidth={1.5} />
              <text x={p.x} y={p.y - CITY_R - 4} textAnchor="middle" fontSize={10} fill="#3a3226">
                {loc.name}
              </text>
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
                      rx={2}
                      fill={tile ? playerColor(tile.player) : '#fffdf5'}
                      stroke={hl ? '#e91e63' : '#6b5b3e'}
                      strokeWidth={hl ? 2.5 : 1}
                      opacity={tile?.flipped ? 0.55 : 1}
                      onClick={onSlotClick ? () => onSlotClick(id, si) : undefined}
                    />
                    {tile ? (
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
                    ) : (
                      slot.industries.map((ind, ii) => {
                        // 空槽位：色块+字母；双产业槽左右各半。
                        const half = slot.industries.length > 1;
                        const cw = half ? (SLOT_W - 4) / 2 : SLOT_W - 4;
                        const cx = x + 2 + ii * cw;
                        const style = INDUSTRY_STYLE[ind];
                        return (
                          <g key={`${id}-slot-${si}-ind-${ii}`} pointerEvents="none">
                            <rect x={cx} y={rowY + 2} width={cw} height={SLOT_H - 4} fill={style.fill} rx={1} />
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

      {/* 商人位：六边形 + 啤酒数 */}
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
    </svg>
  );
}
