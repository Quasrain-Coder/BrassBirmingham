/**
 * 对局导出/导入集成测试：
 * - export_game 返回种子+全量行动前缀;
 * - import_game 以该前缀开新局(快照 seq/era/round 与源一致),房内连接自动解绑旧房;
 * - 其余真人座位开放,join_room 可补位进已开局对局。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameRecord } from '@brass/protocol';
import { createGameServer, type GameServer } from '../src/ws.js';
import { TestClient } from './helpers.js';

const PV = 1;

describe('对局导出/导入', () => {
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

  it('导出→以前缀导入开新局→开放座位可补位', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brass-import-'));
    const s1 = await boot();
    const a = await connect(s1.port);
    const credA = await a.send(
      { type: 'create_room', protocolVersion: PV, nickname: 'A', config: { playerCount: 2, seed: 7 } },
      'credentials',
    );
    const roomState0 = await a.nextMessage('room_state');
    const oldCode = roomState0.room.code as string;
    // 纯真人局:第二个玩家先进房再开局(否则导入后没有开放的真人座位可测)
    const c0 = await connect(s1.port);
    await c0.send({ type: 'join_room', protocolVersion: PV, code: oldCode, nickname: 'C0' }, 'credentials');
    await a.send({ type: 'start_game', protocolVersion: PV, token: credA.token });
    const snap = await a.nextMessage('snapshot');
    // 真人 submit + end_turn 各一次,产生一条落库行动
    a.send({ type: 'submit_action', protocolVersion: PV, token: credA.token, action: snap.legalActions[0] });
    await a.nextMessage('action_applied');
    a.send({ type: 'end_turn', protocolVersion: PV, token: credA.token });

    // 导出:记录含 1 条行动
    a.send({ type: 'export_game', protocolVersion: PV, token: credA.token });
    const exp = await a.nextMessage('export_data');
    const record = exp.record as GameRecord;
    expect(record.version).toBe(1);
    expect(record.playerCount).toBe(2);
    expect(record.seed).toBe(7);
    expect(record.actions).toHaveLength(1);
    expect(record.seats).toHaveLength(2);

    // 同一连接直接导入(应先自动解绑旧房):以全部行动开新局,坐 seat 0
    a.send({ type: 'import_game', protocolVersion: PV, record, seat: 0, nickname: 'B' });
    const credB = await a.nextMessage('credentials');
    expect(credB.seat).toBe(0);
    const snap2 = await a.nextMessage('snapshot');
    expect(snap2.seq).toBe(1);
    expect(snap2.state.era).toBe('canal');
    // 队列里可能有旧房间/解绑广播的 room_state;等到"新开局且非旧码"那条
    let code = '';
    for (let i = 0; i < 6; i += 1) {
      const roomState = await a.nextMessage('room_state');
      if (roomState.room.started === true && roomState.room.code !== oldCode) {
        code = roomState.room.code as string;
        break;
      }
    }
    expect(code).not.toBe('');

    // 另一个客户端 join 该房间:补位到开放的真人座位(seat 1)
    const b = await connect(s1.port);
    const credC = await b.send(
      { type: 'join_room', protocolVersion: PV, code, nickname: 'C' },
      'credentials',
    );
    expect(credC.seat).toBe(1);
    const snap3 = await b.nextMessage('snapshot');
    expect(snap3.seq).toBe(1);
  }, 20_000);

  it('import_game 行动者错位 → import-invalid', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brass-import-'));
    const s1 = await boot();
    const a = await connect(s1.port);
    await a.send(
      { type: 'create_room', protocolVersion: PV, nickname: 'A', config: { playerCount: 2, seed: 7 } },
      'credentials',
    );
    const bad: GameRecord = {
      version: 1,
      playerCount: 2,
      seed: 7,
      seats: [
        { seat: 0, nickname: 'A', isAI: false },
        { seat: 1, nickname: 'B', isAI: false },
      ],
      actions: [{ seq: 0, player: 1 as 0 | 1, action: { type: 'pass', cardId: 'x' } }],
    };
    a.send({ type: 'import_game', protocolVersion: PV, record: bad, seat: 0, nickname: 'B' });
    const err = await a.nextMessage('error');
    expect(err.code).toBe('import-invalid');
  }, 20_000);
});
