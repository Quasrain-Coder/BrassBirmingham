/**
 * session restore 集成测试：服务器重启后，进行中的对局按库（games + actions 表）
 * 重放恢复，resume 不再 session-lost。
 *
 * 覆盖：
 * - 双人局：行动落库后重启 → resume 回 credentials + 快照（seq 连续），可继续提交；
 * - 真人 + AI 局：重启恢复后 agents 索引重建，driveAI 照常推进（收到 AI 的 action_applied）；
 * - 已终局的对局不可恢复（resume 回 session-lost）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newGame } from '@brass/engine';
import { findSeatByToken, finishGame, openDb } from '../src/db/repo.js';
import { createGameServer, type GameServer } from '../src/ws.js';
import { TestClient, type Msg } from './helpers.js';

const PV = 1;

describe('session restore（服务器重启后按库重放恢复）', () => {
  let dir = '';
  let servers: GameServer[] = [];
  let clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
    if (dir !== '') await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  async function boot(): Promise<GameServer> {
    const server = await createGameServer({ port: 0, dbPath: join(dir, 'play.db') });
    servers.push(server);
    return server;
  }

  async function connect(port: number): Promise<TestClient> {
    const client = await TestClient.connect(port);
    clients.push(client);
    return client;
  }

  /** 关掉某个服务器（从注册表摘除，afterEach 不再重复关）。 */
  async function shutdown(server: GameServer): Promise<void> {
    await server.close();
    servers.splice(servers.indexOf(server), 1);
  }

  it('双人局：重启后 resume 恢复，seq 连续且可继续提交', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brass-restore-'));
    const s1 = await boot();
    const a = await connect(s1.port);
    const b = await connect(s1.port);
    const credA = await a.send(
      { type: 'create_room', protocolVersion: PV, nickname: 'A', config: { playerCount: 2, seed: 7 } },
      'credentials',
    );
    const code = (await a.nextMessage('room_state')).room.code as string;
    const credB = await b.send(
      { type: 'join_room', protocolVersion: PV, code, nickname: 'B' },
      'credentials',
    );
    await a.send({ type: 'start_game', protocolVersion: PV, token: credA.token });
    const snapA = await a.nextMessage('snapshot');
    const snapB = await b.nextMessage('snapshot');
    // 首行动方提交一个合法行动（seq 0 落库）
    const aFirst = (snapA.legalActions as unknown[]).length > 0;
    const actor = aFirst ? a : b;
    const actorToken = (aFirst ? credA.token : credB.token) as string;
    const firstAction = (aFirst ? snapA : snapB).legalActions[0] as Record<string, unknown>;
    actor.send({ type: 'submit_action', protocolVersion: PV, token: actorToken, action: firstAction });
    const applied = await actor.nextMessage('action_applied');
    expect(applied.seq).toBe(0);

    // 重启：关掉服务器（内存 session 全丢），同一库文件重起
    await shutdown(s1);
    const s2 = await boot();
    const a2 = await connect(s2.port);
    const resumed = await a2.send(
      { type: 'resume', protocolVersion: PV, token: credA.token },
      'credentials',
    );
    expect(resumed.seat).toBe(credA.seat);
    const snap = await a2.nextMessage('snapshot');
    expect(snap.seq).toBe(1); // 重放到 seq=1,与重启前连续
    expect(snap.state.round).toBe(1);

    // 恢复后对局功能完好:当前玩家可继续提交(seq 连续递增)
    const b2 = await connect(s2.port);
    await b2.send({ type: 'resume', protocolVersion: PV, token: credB.token }, 'credentials');
    const snapB2 = await b2.nextMessage('snapshot');
    const turnA2 = (snap.legalActions as unknown[]).length > 0;
    const current = turnA2 ? a2 : b2;
    const currentToken = (turnA2 ? credA.token : credB.token) as string;
    const currentSnap = turnA2 ? snap : snapB2;
    current.send({
      type: 'submit_action',
      protocolVersion: PV,
      token: currentToken,
      action: currentSnap.legalActions[0],
    });
    const applied2 = await current.nextMessage('action_applied');
    expect(applied2.seq).toBe(1);
  });

  it('真人 + AI 局：重启恢复后 agents 重建,driveAI 照常推进', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brass-restore-'));
    const s1 = await boot();
    const a = await connect(s1.port);
    const credA = await a.send(
      {
        type: 'create_room',
        protocolVersion: PV,
        nickname: 'A',
        config: { playerCount: 2, seed: 7, aiSeats: { count: 1, difficulty: 'normal' } },
      },
      'credentials',
    );
    await a.send({ type: 'start_game', protocolVersion: PV, token: credA.token });
    const mySeat = credA.seat as number;

    /** 轮到就动、被扣住就放行,直到看到一条 AI 的 action_applied。
     *  注意:end_turn 后若顺位重排仍是自己先动,服务端不会产生任何 action_applied,
     *  盲目等待会死锁——end_turn 后先读下一个快照再分流:自己回合继续动,
     *  AI 回合(legal=0 且无扣留)才等待其行动。 */
    async function playUntilAIActs(client: TestClient, token: string, maxRounds: number): Promise<boolean> {
      for (let i = 0; i < maxRounds; i += 1) {
        const snap = await client.nextMessage('snapshot');
        if ((snap.legalActions as unknown[]).length > 0) {
          client.send({
            type: 'submit_action',
            protocolVersion: PV,
            token,
            action: snap.legalActions[0],
          });
          const applied = await client.nextMessage('action_applied', undefined, 10_000);
          if ((applied.player as number) !== mySeat) return true;
          continue;
        }
        if (snap.turnHold === mySeat) {
          client.send({ type: 'end_turn', protocolVersion: PV, token });
          continue;
        }
        // AI 回合:等待其行动
        const applied = await client.nextMessage('action_applied', undefined, 10_000);
        if ((applied.player as number) !== mySeat) return true;
      }
      return false;
    }

    // 确保 AI 至少动过一次再重启(对局确实在推进)
    expect(await playUntilAIActs(a, credA.token as string, 6)).toBe(true);

    // 重启 + resume 恢复;恢复后 AI 仍能行动(agents 索引重建成功)
    await shutdown(s1);
    const s2 = await boot();
    const a2 = await connect(s2.port);
    await a2.send({ type: 'resume', protocolVersion: PV, token: credA.token }, 'credentials');
    expect(await playUntilAIActs(a2, credA.token as string, 16)).toBe(true);
  }, 30_000);

  it('已终局对局可恢复:resume 重放重建为只读对局(查看终局盘面/记录)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brass-restore-'));
    const s1 = await boot();
    const a = await connect(s1.port);
    const credA = await a.send(
      { type: 'create_room', protocolVersion: PV, nickname: 'A', config: { playerCount: 2, seed: 7 } },
      'credentials',
    );
    const code = (await a.nextMessage('room_state')).room.code as string;
    const b = await connect(s1.port);
    await b.send({ type: 'join_room', protocolVersion: PV, code, nickname: 'B' }, 'credentials');
    await a.send({ type: 'start_game', protocolVersion: PV, token: credA.token });
    await a.nextMessage('snapshot');

    // 把对局直接标成 finished(模拟已终局);restore 放行 finished → 按 actions 重放重建
    const db = openDb(join(dir, 'play.db'));
    const persisted = findSeatByToken(db, credA.token as string);
    expect(persisted).not.toBeNull();
    finishGame(db, persisted!.gameId, newGame(2, 7));

    await shutdown(s1);
    const s2 = await boot();
    const a2 = await connect(s2.port);
    await a2.send({ type: 'resume', protocolVersion: PV, token: credA.token }, 'credentials');
    const snap = await a2.nextMessage('snapshot');
    expect(snap.state).toBeDefined();
  });
});
