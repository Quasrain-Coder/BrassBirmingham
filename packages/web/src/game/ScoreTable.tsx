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
          <p className="board-empty">尚未到时代末结算;当前只显示总分。</p>
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
        <table className="score-table score-total">
          <caption>当前总分</caption>
          <tbody>
            {state.players.map((p, i) => (
              <tr key={i}>
                <td>
                  <span className="color-dot" style={{ background: PLAYER_COLORS[i] }} />
                  {playerName(room ?? undefined, i as PlayerIndex)}
                </td>
                <td>{p.vp} 分</td>
              </tr>
            ))}
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
