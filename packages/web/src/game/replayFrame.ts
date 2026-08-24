/**
 * 回看模式的重放计算:一遍重放生产与正式对战同口径的簿记——
 * 按座位的时代行动(含实际现金变化与轮末收入合成条目)、本时代打出记录(含百搭)、
 * 运河时代末分数构成(清算前快照,与 useScoreHistory 同口径)。
 */
import { applyAction, incomeLevelAt, newGame } from '@brass/engine';
import type { Card, GameState, PlayerIndex } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import type { FilteredState, GameRecord } from '@brass/protocol';
import type { EraActionEntry } from './eraLog';
import { computeEraBreakdown, type EraScoreEntry } from './ScoreTable';

export interface ReviewFrame {
  state: FilteredState;
  /** 当前时代的各座位行动簿记(个人版图本回合/历史、行动日志用)。 */
  eraActions: EraActionEntry[][];
  /** 当前时代各座位已打出的牌(含百搭)。 */
  playedCards: Card[][];
  /** 运河时代末分数构成(step 已过时代切换才有;否则 null)。 */
  canalEntry: EraScoreEntry | null;
}

export function replayFrame(record: GameRecord, step: number, viewSeat: PlayerIndex): ReviewFrame {
  const pc = record.playerCount;
  const seatIds = Array.from({ length: pc }, (_, i) => i as PlayerIndex);
  const playedThisEra: Card[][] = Array.from({ length: pc }, () => []);
  const eraActions: EraActionEntry[][] = Array.from({ length: pc }, () => []);
  let canalEntry: EraScoreEntry | null = null;
  let s: GameState = newGame(pc, record.seed);
  for (const { player, action } of record.actions.slice(0, step)) {
    // 打出记录(须在 applyAction 前按应用前手牌查卡面;含百搭)
    const hand = s.players[player]!.hand;
    const ids = action.type === 'scout' ? action.cardIds : [action.cardId];
    for (const id of ids) {
      const card = hand.find((c) => c.id === id);
      if (card !== undefined) playedThisEra[player]!.push(card);
    }
    const moneyBefore = s.players[player]!.money;
    const roundBefore = s.round;
    const eraBefore = s.era;
    const preApply = s;
    s = applyAction(s, action);
    // 轮末收入拆分(与服务端 submitAction/restore 同一簿记:真实行动在前,收入 note 在后)
    let moneyDelta = s.players[player]!.money - moneyBefore;
    if (s.round > roundBefore || s.era !== eraBefore) {
      moneyDelta -= incomeLevelAt(s.players[player]!.incomeSpace);
    }
    eraActions[player]!.push({ action, moneyDelta });
    if (s.round > roundBefore || s.era !== eraBefore) {
      // 收入为 0 也记条目——前端轮标签要显式展示"（收入 +£0）"
      for (const p of seatIds) {
        eraActions[p]!.push({
          action: { type: 'pass', cardId: '__round-income__' },
          moneyDelta: incomeLevelAt(s.players[p]!.incomeSpace),
          note: 'round-income',
        });
      }
    }
    if (s.era !== eraBefore) {
      // 运河末构成:与正式界面(useScoreHistory)同口径——收官行动已应用、结算未发生的
      // canal 终态(inline 重放该行动时结算已并入,故用 defer 补放一次取待结算态)
      const pending = applyAction(preApply, action, { deferRoundEnd: true });
      canalEntry = {
        label: '运河时代末',
        breakdown: computeEraBreakdown(filterStateFor(pending, 0)),
      };
      for (const p of seatIds) {
        playedThisEra[p] = [];
        eraActions[p] = [];
      }
    }
  }
  return { state: filterStateFor(s, viewSeat), eraActions, playedCards: playedThisEra, canalEntry };
}
