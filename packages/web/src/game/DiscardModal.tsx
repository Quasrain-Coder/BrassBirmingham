/**
 * 本时代打出记录弹层：实体规则"弃牌堆公开"的按玩家视图——各座位本时代已打出的
 * 牌按打出顺序展示（数据来自服务端 session 簿记,resume/重放后仍完整）。
 * - 运河时代每列首张为开局暗置卡背（规则书 p.5 步骤 9:每玩家各暗弃 1 张垫底,不公开）;
 * - Wild 卡弃置回供应区,不入列;时代切换（弃牌合洗进新牌堆）后列表重计、无暗置首张。
 */
import type { ReactElement } from 'react';
import type { Card, PlayerIndex } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { PLAYER_COLORS } from '../board/BoardSvg';
import { cardName } from './display';
import { cardImageSrc, playerName } from './Panels';

export function DiscardModal({
  state,
  playedCards,
  room,
  onClose,
}: {
  state: FilteredState;
  playedCards: Card[][];
  room?: RoomState | undefined;
  onClose: () => void;
}): ReactElement {
  const faceDown = state.era === 'canal' ? 1 : 0;
  return (
    <div className="modal-backdrop" data-testid="discard-modal" onClick={onClose}>
      <section className="score-modal discard-modal" onClick={(e) => e.stopPropagation()}>
        <header className="score-modal-head">
          <h3>本时代打出记录</h3>
          <button
            type="button"
            className="modal-close"
            data-testid="discard-modal-close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="discard-columns">
          {state.players.map((_, i) => {
            const cards = playedCards[i] ?? [];
            return (
              <div className="discard-col" key={i} data-testid={`discard-col-${i}`}>
                <div className="discard-col-head">
                  <span
                    className="color-dot"
                    style={{ background: PLAYER_COLORS[i as PlayerIndex] }}
                  />
                  {playerName(room, i as PlayerIndex)}（{cards.length + faceDown}）
                </div>
                <div className="discard-cards">
                  {faceDown === 1 ? (
                    <span className="discard-cell">
                      <img
                        className="discard-card discard-card-back"
                        src="/assets/cards/back.png"
                        alt="开局暗置"
                      />
                      <span className="card-tip">开局暗置（不公开）</span>
                    </span>
                  ) : null}
                  {cards.map((c) => (
                    <span className="discard-cell" key={c.id}>
                      <img className="discard-card" src={cardImageSrc(c)} alt={cardName(c)} />
                      <span className="card-tip">{cardName(c)}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
