import type { ReactElement } from 'react';
import type { AIReasoningEntry } from '@brass/protocol';
import { describeAction } from './display';

/** 终局后的 AI 推理全文：每行一小动，逐轮保留原文与换行。 */
export function AIReasoningModal({
  name,
  entries,
  loading = false,
  onClose,
}: {
  name: string;
  entries: AIReasoningEntry[];
  loading?: boolean;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="modal-backdrop" data-testid="ai-reasoning-modal" onClick={onClose}>
      <section className="score-modal reasoning-modal" onClick={(event) => event.stopPropagation()}>
        <header className="score-modal-head">
          <h3>{name} 的 AI 推理</h3>
          <button type="button" className="modal-close" data-testid="ai-reasoning-close" onClick={onClose}>×</button>
        </header>
        <div className="reasoning-actions">
          {loading ? <p className="reasoning-empty">正在读取终局推理…</p> : null}
          {!loading && entries.length === 0 ? <p className="reasoning-empty">本局没有保存推理正文。</p> : null}
          {!loading && entries.length > 0 ? entries.map((entry, index) => (
            <details
              className="reasoning-action"
              data-testid={`reasoning-action-${entry.seq}`}
              key={entry.seq}
              open={index === entries.length - 1}
            >
              <summary>
                <span className="reasoning-action-seq">第 {entry.seq + 1} 动</span>
                {describeAction(entry.action)}
              </summary>
              <div className="reasoning-rounds">
                {entry.reasoning.rounds.map((round) => (
                  <section className="reasoning-round" key={round.round}>
                    <h4>第 {round.round} 次模型响应{round.toolCalls.length > 0 ? ` · ${round.toolCalls.join('、')}` : ''}</h4>
                    {round.reasoning ? <pre>{round.reasoning}</pre> : <p className="reasoning-empty">本次响应未提供推理正文。</p>}
                    {round.text ? <pre className="reasoning-visible-text">{round.text}</pre> : null}
                  </section>
                ))}
              </div>
            </details>
          )) : null}
        </div>
      </section>
    </div>
  );
}
