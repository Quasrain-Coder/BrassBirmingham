/**
 * WS 级 turnHold 集成测试：真人回合打满被扣住 → 提交被拒 → end_turn 放行 /
 * reset_turn 回滚（快照 seq/手牌复原）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestClient } from './helpers.js';

const harness = createTestHarness();
afterEach(() => harness.cleanup());

const PV = 1;

interface Setup {
  actor: TestClient;
  other: TestClient;
  actorToken: string;
  otherToken: string;
  actorSeat: number;
  actorHandCount: number;
  firstAction: Record<string, unknown>;
}

/** 2p 开局（seed 7），返回首个行动方、其手牌数与首个合法行动。 */
async function setup(): Promise<Setup> {
  const server = await harness.startServer();
  const a = await harness.connect(server.port);
  const b = await harness.connect(server.port);
  const credA = await a.send(
    { type: 'create_room', protocolVersion: PV, nickname: 'A', config: { playerCount: 2, seed: 7 } },
    'credentials',
  );
  const code = (await a.nextMessage('room_state')).room.code as string;
  const credB = await b.send({ type: 'join_room', protocolVersion: PV, code, nickname: 'B' }, 'credentials');
  await a.send({ type: 'start_game', protocolVersion: PV, token: credA.token });
  const snapA = await a.nextMessage('snapshot');
  const snapB = await b.nextMessage('snapshot');
  const aFirst = (snapA.legalActions as unknown[]).length > 0;
  const actorSeat = aFirst ? 0 : 1;
  const actorSnap = aFirst ? snapA : snapB;
  const actorHand = (actorSnap.state as { players: { hand: { kind: string; cards?: unknown[] } }[] })
    .players[actorSeat]!.hand;
  return {
    actor: aFirst ? a : b,
    other: aFirst ? b : a,
    actorToken: (aFirst ? credA.token : credB.token) as string,
    otherToken: (aFirst ? credB.token : credA.token) as string,
    actorSeat,
    actorHandCount: actorHand.kind === 'full' ? actorHand.cards!.length : -1,
    firstAction: actorSnap.legalActions[0] as Record<string, unknown>,
  };
}

describe('WS turnHold(回合扣住)', () => {
  it('运河首轮 1 行动后扣住:turnHold=座位,提交被拒,end_turn 放行', async () => {
    const { actor, other, actorToken, otherToken, actorSeat, firstAction } = await setup();
    actor.send({ type: 'submit_action', protocolVersion: PV, token: actorToken, action: firstAction });
    await actor.nextMessage('action_applied');
    // 扣住:双方快照都带 turnHold=行动方座位
    const holdA = await actor.nextMessage('snapshot', (m) => m.turnHold != null);
    expect(holdA.turnHold).toBe(actorSeat);
    const holdB = await other.nextMessage('snapshot', (m) => m.turnHold != null);
    expect(holdB.turnHold).toBe(actorSeat);
    // 扣住期间:任何 submit(包括下一玩家)被拒
    other.send({
      type: 'submit_action',
      protocolVersion: PV,
      token: otherToken,
      action: { type: 'pass', cardId: 'x' },
    });
    const err = await other.nextMessage('error');
    expect(err.code).toBe('awaiting-turn-confirm');
    // end_turn 放行:turnHold 清空,快照恢复
    actor.send({ type: 'end_turn', protocolVersion: PV, token: actorToken });
    const released = await actor.nextMessage('snapshot', (m) => m.turnHold === null);
    expect(released.seq).toBe(1);
    // 下一玩家可行动
    const legalB = await other.nextMessage(
      'snapshot',
      (m) => (m.legalActions as unknown[]).length > 0,
    );
    expect(legalB.legalActions.length).toBeGreaterThan(0);
  });

  it('reset_turn 回滚:seq/手牌/现金复原,可重新行动', async () => {
    const { actor, other, actorToken, actorSeat, actorHandCount, firstAction } = await setup();
    actor.send({ type: 'submit_action', protocolVersion: PV, token: actorToken, action: firstAction });
    await actor.nextMessage('action_applied');
    await actor.nextMessage('snapshot', (m) => m.turnHold != null);
    actor.send({ type: 'reset_turn', protocolVersion: PV, token: actorToken });
    const back = await actor.nextMessage('snapshot', (m) => m.turnHold === null);
    expect(back.seq).toBe(0);
    const handBack = (back.state as { players: { hand: { kind: string; cards?: unknown[] } }[] })
      .players[actorSeat]!.hand;
    expect(handBack.kind === 'full' ? handBack.cards!.length : -1).toBe(actorHandCount);
    // 回到回合初,可重新行动(legalActions 非空)
    expect((back.legalActions as unknown[]).length).toBeGreaterThan(0);
    // 全场广播 turn_reset(他人据以撤下暂存预览并播报"已重置本回合")
    const notice = await other.nextMessage('turn_reset');
    expect(notice.seat).toBe(actorSeat);
  });

  it('回合进行中撤回:第 1 动后 reset_turn 回到回合初(无需等回合打满)', async () => {
    const { actor, other, actorToken, otherToken, actorSeat, actorHandCount, firstAction } = await setup();
    const otherSeat = 1 - actorSeat;
    // 首个行动(其 seq=0 快照已在 setup 中消费):打出后从 seq=1 起统一按 seq 驱动
    actor.send({ type: 'submit_action', protocolVersion: PV, token: actorToken, action: firstAction });
    await actor.nextMessage('action_applied');
    let seq = 1;
    for (;;) {
      const [sa, sb] = await Promise.all([
        actor.nextMessage('snapshot', (m) => m.seq === seq),
        other.nextMessage('snapshot', (m) => m.seq === seq),
      ]);
      if (sa.turnHold === actorSeat) {
        actor.send({ type: 'end_turn', protocolVersion: PV, token: actorToken });
        continue;
      }
      if (sb.turnHold === otherSeat) {
        other.send({ type: 'end_turn', protocolVersion: PV, token: otherToken });
        continue;
      }
      const aFirst = (sa.legalActions as unknown[]).length > 0;
      const driver = aFirst ? actor : other;
      const driverToken = aFirst ? actorToken : otherToken;
      const legal = (aFirst ? sa.legalActions : sb.legalActions) as Record<string, unknown>[];
      driver.send({ type: 'submit_action', protocolVersion: PV, token: driverToken, action: legal[0]! });
      await driver.nextMessage('action_applied');
      if (aFirst && seq >= 2) break; // 第 2 轮我方第 1 动完成
      seq++;
    }

    // 回合进行中(actionsThisTurn=1,未被扣住)→ 可撤回到回合初
    actor.send({ type: 'reset_turn', protocolVersion: PV, token: actorToken });
    const back = await actor.nextMessage(
      'snapshot',
      (m) => m.turnHold === null && (m.state as { actionsThisTurn: number }).actionsThisTurn === 0,
    );
    const st = back.state as {
      actionsThisTurn: number;
      players: { hand: { kind: string; cards?: unknown[] } }[];
    };
    const handBack = st.players[actorSeat]!.hand;
    expect(handBack.kind === 'full' ? handBack.cards!.length : -1).toBe(actorHandCount);
    expect((back.legalActions as unknown[]).length).toBeGreaterThan(0); // 仍是我方回合
  });

  it('end_turn 时机错误:未被扣住时发 end_turn 回 no-turn-hold', async () => {
    const { actor, actorToken } = await setup();
    actor.send({ type: 'end_turn', protocolVersion: PV, token: actorToken });
    const err = await actor.nextMessage('error');
    expect(err.code).toBe('no-turn-hold');
  });
});
