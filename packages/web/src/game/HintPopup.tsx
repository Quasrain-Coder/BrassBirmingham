/**
 * "提示卡"悬浮窗:当前人数(2/3/4 人)下的牌堆构成速查——各城市卡数量、
 * 产业卡(单图标/双图标)数量与百搭卡数量。数据实时取自引擎 buildDeck(单一来源)。
 * 悬浮窗锚定在按钮附近(非屏幕居中),点击遮罩任意处关闭。
 */
import type { ReactElement } from 'react';
import { buildDeck, WILD_INDUSTRY_COUNT, WILD_LOCATION_COUNT } from '@brass/engine';
import type { Card } from '@brass/engine';
import { cardName } from './display';

export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
  right: number;
}

interface FaceGroup {
  key: string;
  label: string;
  count: number;
}

function groupDeck(playerCount: 2 | 3 | 4): { locations: FaceGroup[]; industries: FaceGroup[] } {
  const deck = buildDeck(playerCount);
  const locMap = new Map<string, number>();
  const indMap = new Map<string, number>();
  for (const c of deck) {
    if (c.kind === 'location') {
      const name = cardName(c as Card);
      locMap.set(name, (locMap.get(name) ?? 0) + 1);
    } else if (c.kind === 'industry') {
      const name = cardName(c as Card);
      indMap.set(name, (indMap.get(name) ?? 0) + 1);
    }
  }
  const toGroups = (m: Map<string, number>): FaceGroup[] =>
    [...m.entries()].map(([label, count]) => ({ key: label, label, count }));
  return { locations: toGroups(locMap), industries: toGroups(indMap) };
}

export function HintPopup({
  playerCount,
  anchor,
  onClose,
}: {
  playerCount: 2 | 3 | 4;
  anchor: AnchorRect;
  onClose: () => void;
}): ReactElement {
  const { locations, industries } = groupDeck(playerCount);
  const width = 300;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
  const top = anchor.bottom + 6;
  return (
    <>
      <div className="hint-backdrop" data-testid="hint-backdrop" onClick={onClose} />
      <section
        className="hint-popup"
        data-testid="hint-popup"
        style={{ left, top, width }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="hint-popup-head">
          <span>{playerCount} 人局牌堆构成</span>
          <button type="button" className="modal-close" data-testid="hint-close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="hint-section">
          <h4>城市卡（共 {locations.reduce((s, g) => s + g.count, 0)} 张）</h4>
          <div className="hint-grid">
            {locations.map((g) => (
              <span key={g.key} className="hint-chip">
                {g.label} ×{g.count}
              </span>
            ))}
          </div>
        </div>
        <div className="hint-section">
          <h4>产业卡（共 {industries.reduce((s, g) => s + g.count, 0)} 张）</h4>
          <div className="hint-grid">
            {industries.map((g) => (
              <span key={g.key} className="hint-chip">
                {g.label} ×{g.count}
              </span>
            ))}
          </div>
        </div>
        <div className="hint-section">
          <h4>百搭（独立供应）</h4>
          <div className="hint-grid">
            <span className="hint-chip">百搭·城市 ×{WILD_LOCATION_COUNT}</span>
            <span className="hint-chip">百搭·产业 ×{WILD_INDUSTRY_COUNT}</span>
          </div>
        </div>
      </section>
    </>
  );
}
