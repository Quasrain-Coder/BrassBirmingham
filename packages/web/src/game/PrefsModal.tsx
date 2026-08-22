/**
 * 偏好设置弹窗(替代原"经典布局"按钮):三个滑动开关,标签分列左右——
 * - 视图切换:宽屏布局 ⇄ 经典布局;
 * - 卡牌悬浮效果:选中集体悬浮 ⇄ 选中单张悬浮;
 * - 个人版图风格:桌游风格 ⇄ 列表风格(原"版图/明细"切换,收口至此)。
 * 全部偏好持久化到 localStorage。
 */
import type { ReactElement } from 'react';

export type HandRaiseMode = 'single' | 'all';
export type StackViewMode = 'mat' | 'list';

export interface Prefs {
  layoutWide: boolean;
  handRaise: HandRaiseMode;
  stackView: StackViewMode;
}

function SlideRow({
  left,
  right,
  leftActive,
  onToggle,
  testid,
}: {
  left: string;
  right: string;
  leftActive: boolean;
  onToggle: () => void;
  testid: string;
}): ReactElement {
  return (
    <div className="pref-row" data-testid={testid}>
      <span className={`pref-side${leftActive ? ' active' : ''}`}>{left}</span>
      <button
        type="button"
        className={`pref-slide${leftActive ? '' : ' right'}`}
        role="switch"
        aria-checked={!leftActive}
        onClick={onToggle}
      >
        <span className="pref-knob" />
      </button>
      <span className={`pref-side${leftActive ? '' : ' active'}`}>{right}</span>
    </div>
  );
}

export function PrefsModal({
  prefs,
  onChange,
  onClose,
}: {
  prefs: Prefs;
  onChange: (next: Prefs) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="modal-backdrop" data-testid="prefs-modal" onClick={onClose}>
      <section className="score-modal prefs-modal" onClick={(e) => e.stopPropagation()}>
        <header className="score-modal-head">
          <h3>偏好设置</h3>
          <button type="button" className="modal-close" data-testid="prefs-close" onClick={onClose}>
            ×
          </button>
        </header>
        <SlideRow
          testid="pref-layout"
          left="宽屏布局"
          right="经典布局"
          leftActive={prefs.layoutWide}
          onToggle={() => onChange({ ...prefs, layoutWide: !prefs.layoutWide })}
        />
        <SlideRow
          testid="pref-hand-raise"
          left="选中集体悬浮"
          right="选中单张悬浮"
          leftActive={prefs.handRaise === 'all'}
          onToggle={() =>
            onChange({ ...prefs, handRaise: prefs.handRaise === 'all' ? 'single' : 'all' })
          }
        />
        <SlideRow
          testid="pref-stack-view"
          left="桌游风格"
          right="列表风格"
          leftActive={prefs.stackView === 'mat'}
          onToggle={() =>
            onChange({ ...prefs, stackView: prefs.stackView === 'mat' ? 'list' : 'mat' })
          }
        />
      </section>
    </div>
  );
}
