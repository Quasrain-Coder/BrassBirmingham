/**
 * 回合扣住(turnHold)与回合重置(resetTurn)测试:
 * - GameSession.resetTurn:恢复回合备份 + 删除本回合落库行动;
 * - WS 层:真人回合打满 → snapshot.turnHold=座位,driveAI 不推进、submit 被拒;
 *   end_turn 放行;reset_turn 回到回合初(手牌/现金/seq 全部回滚)。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerIndex } from '@brass/engine';
import { listActions, openDb } from '../src/db/repo.js';
import { GameSession } from '../src/session.js';

function seatsFor(playerCount: number, tokenPrefix = 'tok') {
  return Array.from({ length: playerCount }, (_, i) => ({
    seat: i as PlayerIndex,
    nickname: `p${i}`,
    token: `${tokenPrefix}-${i}`,
  }));
}

describe('GameSession.resetTurn', () => {
  it('运河首轮 1 行动后重置:状态与 seq 回到回合初,落库行动删除', () => {
    const db = openDb(':memory:');
    const sess = new GameSession(db, 'g_reset', 4, 42, seatsFor(4));
    const seat = sess.currentSeat;
    const before = sess.state;
    const handBefore = before.players[seat]!.hand.length;
    const snap = sess.snapshotFor(seat);
    const act = snap.legalActions.find((a) => a.type === 'pass')!;
    sess.submitAction(seat, act);
    expect(sess.currentSeat).not.toBe(seat); // 首轮 1 行动,回合已推进
    expect(listActions(db, 'g_reset')).toHaveLength(1);

    expect(sess.resetTurn()).toBe(true);
    expect(sess.currentSeat).toBe(seat);
    expect(sess.currentSeq).toBe(0);
    expect(sess.state.players[seat]!.hand).toHaveLength(handBefore);
    expect(listActions(db, 'g_reset')).toHaveLength(0);
    // 二次重置无备份 → false
    expect(sess.resetTurn()).toBe(false);
  });

  it('2 行动回合:第 1 动后不备份覆盖,重置回到回合初而非第 2 动前', () => {
    const db = openDb(':memory:');
    const sess = new GameSession(db, 'g_reset2', 4, 42, seatsFor(4));
    // 快进过运河首轮(4 人各 1 动,这里直接连打 4 个 pass 进入第 2 轮)
    for (let k = 0; k < 4; k++) {
      const seat = sess.currentSeat;
      const pass = sess.snapshotFor(seat).legalActions.find((a) => a.type === 'pass')!;
      sess.submitAction(seat, pass);
    }
    expect(sess.state.round).toBe(2);
    const seat = sess.currentSeat;
    const seqStart = sess.currentSeq;
    const moneyStart = sess.state.players[seat]!.money;
    const loan = sess.snapshotFor(seat).legalActions.find((a) => a.type === 'loan')!;
    sess.submitAction(seat, loan);
    expect(sess.currentSeat).toBe(seat); // 2 行动回合,仍是自己
    const pass = sess.snapshotFor(seat).legalActions.find((a) => a.type === 'pass')!;
    sess.submitAction(seat, pass);
    expect(sess.currentSeat).not.toBe(seat);

    expect(sess.resetTurn()).toBe(true);
    expect(sess.currentSeat).toBe(seat);
    expect(sess.currentSeq).toBe(seqStart);
    expect(sess.state.players[seat]!.money).toBe(moneyStart); // £30 贷款也回滚
    expect(listActions(db, 'g_reset2')).toHaveLength(seqStart);
  });
});
