/**
 * 时代末分数构成表（规则书 p.7 时代末计分:Link 连接图标 + 翻面产业 VP）。
 *
 * 客户端从"时代切换前"的快照本地推算每个玩家的得分构成:
 * - Link 分:自己每条 Link 两端相邻地点内,已翻面产业板块上的连接图标(linkIcons)总数;
 * - 产业分:自己场上已翻面板块的左下 VP 总和;
 * 与引擎 era.ts 的计分算法一致(audit-H 已验证)。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { PlayerIndex } from '@brass/engine';
import { LINKS, LINK_EXTRA_ENDPOINTS, LOCATIONS } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { PLAYER_COLORS } from '../board/BoardSvg';
import { playerName } from './Panels';

export interface EraScoreRow {
  linkVp: number;
  industryVp: number;
}

/** 由时代末(清算前)快照计算每位玩家的时代得分构成。 */
export function computeEraBreakdown(state: FilteredState): Map<PlayerIndex, EraScoreRow> {
  const out = new Map<PlayerIndex, EraScoreRow>();
  for (let p = 0; p < state.playerCount; p++) out.set(p as PlayerIndex, { linkVp: 0, industryVp: 0 });

  /** 地点 locId 上所有已翻面板块(不分归属)的连接图标总数——Link 计分规则不看板块归属。 */
  const iconsAt = (locId: string): number => {
    let n = 0;
    for (const t of state.board.slots[locId as keyof typeof state.board.slots] ?? []) {
      if (t && t.flipped) n += t.tile.linkIcons;
    }
    return n;
  };

  for (const link of state.board.links) {
    const def = LINKS[link.linkIndex]!;
    const endpoints = [def.a, def.b, ...(LINK_EXTRA_ENDPOINTS[link.linkIndex] ?? [])];
    const row = out.get(link.player)!;
    for (const ep of endpoints) {
      if (ep in LOCATIONS) row.linkVp += iconsAt(ep);
    }
  }

  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.flipped) out.get(t.player)!.industryVp += t.tile.vp;
    }
  }
  return out;
}

export interface EraScoreEntry {
  /** 展示标题,如「运河时代末」/「铁路时代末(终局)」。 */
  label: string;
  breakdown: Map<PlayerIndex, EraScoreRow>;
}

export interface ProvisionalRow {
  /** 分数轨分(上时代总分 + 已得贸易商 VP 奖励)。 */
  trackVp: number;
  linkVp: number;
  industryVp: number;
  /** ≥2 级翻面板块的 VP(这些板块在铁路时代末还会再计一次分)。 */
  industryVpL2: number;
}

/**
 * 暂定总分(实时):点击弹窗时按当前快照计算——轨迹分 + 当前所有翻面产业分 +
 * 当前所有连接分。只反映已落库的行动(回合内已提交的行动在快照里自然计入;
 * 若被 resetTurn 撤回,快照回滚后自然消失,无需特判)。
 * 口径:时代进行中,合计 = 轨迹分 + 连接 + 产业(= 假设时代立刻结束的总分);
 * 终局(phase==='game-over')时这些分项已并入轨迹——轨迹列改显"前段累计"
 * (轨迹 − 连接 − 产业),合计 = 轨迹分本身,不再双重计分。
 */
export function computeProvisional(state: FilteredState): Map<PlayerIndex, ProvisionalRow> {
  const out = new Map<PlayerIndex, ProvisionalRow>();
  for (let p = 0; p < state.playerCount; p++) {
    out.set(p as PlayerIndex, {
      trackVp: state.players[p]!.vp,
      linkVp: 0,
      industryVp: 0,
      industryVpL2: 0,
    });
  }
  const iconsAt = (locId: string): number => {
    let n = 0;
    for (const t of state.board.slots[locId as keyof typeof state.board.slots] ?? []) {
      if (t && t.flipped) n += t.tile.linkIcons;
    }
    return n;
  };
  for (const link of state.board.links) {
    const def = LINKS[link.linkIndex]!;
    const endpoints = [def.a, def.b, ...(LINK_EXTRA_ENDPOINTS[link.linkIndex] ?? [])];
    const row = out.get(link.player)!;
    for (const ep of endpoints) {
      if (ep in LOCATIONS) row.linkVp += iconsAt(ep);
    }
  }
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.flipped) {
        out.get(t.player)!.industryVp += t.tile.vp;
        if (t.tile.level >= 2) out.get(t.player)!.industryVpL2 += t.tile.vp;
      }
    }
  }
  return out;
}

/** 时代切换侦测:返回时代切换前的快照(canal→rail 或 进入 game-over 时)。 */
export function usePreviousSnapshot(state: FilteredState): FilteredState | undefined {
  const ref = useRef<FilteredState>(undefined);
  useEffect(() => {
    ref.current = state;
  }, [state]);
  return ref.current;
}

/** 分数构成弹窗(手动关闭;表格 = 各时代得分构成 + 当前总分)。 */
export function ScoreModal({
  entries,
  state,
  room,
  onClose,
}: {
  entries: EraScoreEntry[];
  state: FilteredState;
  room: RoomState | null;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="modal-backdrop" data-testid="score-modal" onClick={onClose}>
      <section className="score-modal" onClick={(e) => e.stopPropagation()}>
        <header className="score-modal-head">
          <h3>分数构成</h3>
          <button type="button" className="modal-close" data-testid="score-modal-close" onClick={onClose}>
            关闭
          </button>
        </header>
        {entries.length === 0 ? (
          <p className="board-empty">尚未到时代末结算;下方为暂定总分(实时)。</p>
        ) : (
          entries.map((entry) => (
            <table className="score-table" key={entry.label} data-testid="score-table">
              <caption>{entry.label}</caption>
              <thead>
                <tr>
                  <th>玩家</th>
                  <th>连接分</th>
                  <th>产业分</th>
                  <th>合计</th>
                </tr>
              </thead>
              <tbody>
                {[...entry.breakdown.entries()].map(([p, row]) => (
                  <tr key={p} data-player={p}>
                    <td>
                      <span className="color-dot" style={{ background: PLAYER_COLORS[p] }} />
                      {playerName(room ?? undefined, p)}
                    </td>
                    <td>{row.linkVp}</td>
                    <td>{row.industryVp}</td>
                    <td>{row.linkVp + row.industryVp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))
        )}
        <table className="score-table score-total" data-testid="score-provisional">
          <caption>
            {state.phase === 'game-over'
              ? '终局总分（轨迹列 = 前段累计，合计 = 轨迹分）'
              : `暂定总分（实时·含已确认行动）${state.era === 'canal' ? '：≥2 级翻面板块在铁路末会再计一次分' : ''}`}
          </caption>
          <thead>
            <tr>
              <th>玩家</th>
              <th>轨迹分</th>
              <th>连接分</th>
              <th>产业分</th>
              <th>{state.era === 'canal' ? '合计(至运河末)' : '合计'}</th>
              {state.era === 'canal' ? <th>合计(含铁路末)</th> : null}
            </tr>
          </thead>
          <tbody>
            {[...computeProvisional(state).entries()].map(([p, row]) => {
              // 终局:引擎计分后 links 已从版图移除,连接/产业列改取时代末构成记录
              // (与上方"铁路时代末"表同源);轨迹列 = 前段累计,合计 = 轨迹分本身
              const settled = state.phase === 'game-over';
              const lastBreakdown =
                settled && entries.length > 0 ? entries[entries.length - 1]!.breakdown.get(p) : undefined;
              const linkCol = settled ? (lastBreakdown?.linkVp ?? row.linkVp) : row.linkVp;
              const indCol = settled ? (lastBreakdown?.industryVp ?? row.industryVp) : row.industryVp;
              const trackCol = settled ? row.trackVp - linkCol - indCol : row.trackVp;
              return (
                <tr key={p} data-player={p}>
                  <td>
                    <span className="color-dot" style={{ background: PLAYER_COLORS[p] }} />
                    {playerName(room ?? undefined, p)}
                  </td>
                  <td>{trackCol}</td>
                  <td>{linkCol}</td>
                  <td>{indCol}</td>
                  <td>{trackCol + linkCol + indCol}</td>
                  {state.era === 'canal' ? (
                    <td>{trackCol + linkCol + indCol + row.industryVpL2}</td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** 分数构成状态:时代切换时追加构成记录;弹窗开关。 */
export function useScoreHistory(state: FilteredState): {
  entries: EraScoreEntry[];
  open: boolean;
  setOpen: (v: boolean) => void;
} {
  const prev = usePreviousSnapshot(state);
  const [entries, setEntries] = useState<EraScoreEntry[]>([]);
  const [open, setOpen] = useState(false);
  const lastKey = `${state.era}:${state.phase}`;
  const prevKeyRef = useRef(lastKey);

  useEffect(() => {
    if (prev === undefined || prevKeyRef.current === lastKey) return;
    const prevKey = prevKeyRef.current;
    prevKeyRef.current = lastKey;
    if (prev.era === 'canal' && state.era === 'rail') {
      setEntries((es) => [...es, { label: '运河时代末', breakdown: computeEraBreakdown(prev) }]);
      setOpen(true);
    } else if (prev.phase !== 'game-over' && state.phase === 'game-over') {
      setEntries((es) => [...es, { label: '铁路时代末（终局）', breakdown: computeEraBreakdown(prev) }]);
      setOpen(true);
    }
  }, [lastKey, prev, state.era, state.phase]);

  return { entries, open, setOpen };
}
