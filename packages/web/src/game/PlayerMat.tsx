/**
 * 玩家建筑版图(官方玩家面板美术版):mat 底图 + 各产业堆叠状态叠加。
 *
 * 叠加规则(数据来自 players[i].tiles,面板为公开信息):
 * - 当前栈顶(可建的最低级)框:**按剩余数量叠放实物板块 token**(玩家色,
 *   逐层偏移,如实体游戏的板块堆),研发/建造移除后堆叠随之减少;
 * - 栈顶框外圈:玩家色描边 + 剩余数角标(始终框住最新可用等级);
 * - 已耗尽等级的框:暗色遮罩(该级板块已全部建出/研发移除);
 * - 更高等级框:原样透出(即将解锁),不叠加。
 */
import type { ReactElement } from 'react';
import type { IndustryType } from '@brass/engine';
import type { TileDef } from '@brass/engine';
import { MAT_IMAGE, MAT_SLOTS } from '../board/mat-geometry';
import { industryName } from './display';

const INDUSTRY_ORDER: IndustryType[] = ['manufacturer', 'cotton', 'pottery', 'coal', 'iron', 'brewery'];

/** 堆叠逐层偏移(同级最多 3 块,最大漂移 10px,不遮成本横幅)。 */
const PILE_DX = 5;
const PILE_DY = -5;

export function PlayerMat({
  tiles,
  playerColor,
  colorKey,
}: {
  /** 该玩家面板剩余堆叠(TileDef 按产业分组、等级升序)。 */
  tiles: TileDef[];
  playerColor: string;
  /** 玩家色 key(板块 token 图文件名用)。 */
  colorKey: 'purple' | 'yellow' | 'orange' | 'teal';
}): ReactElement {
  // 每产业每等级剩余数;栈顶 = 剩余数 >0 的最低级
  const remaining = new Map<string, number>();
  for (const def of tiles) {
    const key = `${def.industry}-${def.level}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  return (
    <svg
      className="player-mat"
      viewBox={`0 0 ${MAT_IMAGE.w} ${MAT_IMAGE.h}`}
      role="img"
      aria-label="玩家建筑版图"
    >
      <image href="/assets/player-mat.jpg" x={0} y={0} width={MAT_IMAGE.w} height={MAT_IMAGE.h} />
      {INDUSTRY_ORDER.map((ind) => {
        const slots = MAT_SLOTS[ind];
        const topLevel = slots.find((s) => (remaining.get(`${ind}-${s.level}`) ?? 0) > 0)?.level;
        return slots.map((slot) => {
          const left = remaining.get(`${ind}-${slot.level}`) ?? 0;
          const isTop = slot.level === topLevel;
          return (
            <g key={`${ind}-${slot.level}`} data-mat-slot={`${ind}-${slot.level}`}>
              {left === 0 ? (
                <rect
                  className="mat-slot-exhausted"
                  x={slot.x}
                  y={slot.y}
                  width={slot.w}
                  height={slot.h}
                  rx={10}
                />
              ) : null}
              {isTop ? (
                <>
                  {/* 实物堆叠:底块贴框,逐层右上偏移(玩家色板块 token) */}
                  <g className="mat-pile">
                    {Array.from({ length: left }, (_, i) => (
                      <image
                        key={i}
                        href={`/assets/tiles/${ind}-${slot.level}-${colorKey}.png`}
                        x={slot.x + i * PILE_DX}
                        y={slot.y + i * PILE_DY}
                        width={slot.w}
                        height={slot.h}
                      />
                    ))}
                  </g>
                  <rect
                    className="mat-slot-top"
                    x={slot.x - 6}
                    y={slot.y - 6}
                    width={slot.w + 12}
                    height={slot.h + 12}
                    rx={14}
                    fill="none"
                    stroke={playerColor}
                    strokeWidth={8}
                  />
                  <g className="mat-slot-count">
                    <rect
                      x={slot.x + slot.w - 76}
                      y={slot.y - 14}
                      width={84}
                      height={52}
                      rx={12}
                      fill="#14100a"
                      opacity={0.9}
                    />
                    <text
                      x={slot.x + slot.w - 34}
                      y={slot.y + 24}
                      textAnchor="middle"
                      fontSize={36}
                      fill="#f3e9c8"
                    >
                      ×{left}
                    </text>
                  </g>
                </>
              ) : null}
              {isTop ? (
                <title>{`${industryName(ind)} Lv${slot.level}（栈顶,剩余 ${left}）`}</title>
              ) : null}
            </g>
          );
        });
      })}
    </svg>
  );
}
