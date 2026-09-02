/**
 * M3 Task 4：AI 座位 + LLM 驱动循环集成测试。
 *
 * 覆盖（brief Step 1 全场景）：
 * - createRoom 的 aiSeats 校验边界：count=0 / count=playerCount / 非法 difficulty
 *   → 'invalid-config'；count=playerCount-1 合法。
 * - startGame 新条件：真人数 >= 1 且（满员 或 真人 + aiSeats.count >= playerCount）；
 *   AI 填充数 = min(count, playerCount - 真人数)（3 真人 + count=2 的 4p 房 clamp 补 1 AI）。
 * - toRoomState：config 扩为 { playerCount, aiSeats? }（仍不含 seed）；SeatInfo.isAI
 *   对 AI 座位为 true；AI 昵称自动（"AI-1（普通）"）。
 * - AI 座位 token：满足 GameSession 构造但永不进 RoomManager.tokenIndex（findByToken
 *   不可达），ws 层也永不下发 credentials。
 * - e2e：2 真人 + 2 AI 完整对局（aiAgentFactory 注入 fixture agent），ai_thinking
 *   广播成对出现（true→false），AI 的 action_applied 带 reason，对局打穿到 game_over。
 * - driveAI 兜底：agent.decide 抛非 API 异常 → error 日志 + Heuristic Top-1 末级
 *   兜底 submitAction，对局不卡死。
 * - 并发守卫：AI 决策中途（gate 悬挂）真人 resume 重触发 driveAI——守卫防重入，
 *   decide 不多调一次（幂等）。
 * - 缺 aiAgentFactory（等价 ANTHROPIC_API_KEY 缺失的降级路径）：默认 HeuristicAgent
 *   驱动，对局照常完成。
 *
 * 防 flake：人类驱动端每连接独立循环"等自己 legalActions 非空的 snapshot → 随机
 * 选一提交"，与 game_over 赛跑收尾，不假设 AI 行动时序与 seq 对齐（同 e2e.test.ts
 * 的独立 RNG 模式）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createRng, type Rng } from '@brass/engine';
import type { Action, GameState, PlayerIndex } from '@brass/engine';
import { HeuristicAgent, type DecidingAgent, type Decision } from '@brass/llm';
import type { GameServer } from '../src/ws.js';
import { RoomManager, toRoomState } from '../src/rooms.js';
import { createTestHarness, type TestClient } from './helpers.js';

const harness = createTestHarness();

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

const PV = 1;
const TURN_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// RoomManager 单元层
// ---------------------------------------------------------------------------

describe('RoomManager AI 座位', () => {
  it('createRoom：aiSeats.count 边界——0 / playerCount / 非整数拒绝（invalid-config）', () => {
    const rm = new RoomManager();
    for (const count of [0, 4, -1, 1.5]) {
      expect(() =>
        rm.createRoom({ playerCount: 4, aiSeats: { count, difficulty: 'normal' } }, 'a'),
      ).toThrowError(expect.objectContaining({ code: 'invalid-config' }) as Error);
    }
    // 2p 房 count 只能为 1（playerCount-1）
    expect(() =>
      rm.createRoom({ playerCount: 2, aiSeats: { count: 2, difficulty: 'easy' } }, 'a'),
    ).toThrowError(expect.objectContaining({ code: 'invalid-config' }) as Error);
    expect(() =>
      rm.createRoom({ playerCount: 2, aiSeats: { count: 1, difficulty: 'easy' } }, 'a'),
    ).not.toThrow();
    expect(() =>
      rm.createRoom({ playerCount: 4, aiSeats: { count: 3, difficulty: 'hard' } }, 'a'),
    ).not.toThrow();
  });

  it('createRoom：非法 difficulty 拒绝（invalid-config）', () => {
    const rm = new RoomManager();
    expect(() =>
      rm.createRoom(
        { playerCount: 2, aiSeats: { count: 1, difficulty: 'nightmare' as 'easy' } },
        'a',
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-config' }) as Error);
  });

  it('startGame：真人 + count >= playerCount 即可开局，clamp 填充并自动昵称', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom(
      { playerCount: 4, aiSeats: { count: 2, difficulty: 'normal' } },
      'alice',
    );
    rm.joinRoom(room.code, 'bob');
    rm.joinRoom(room.code, 'carol');
    // 3 真人 + count=2 >= 4 → 可开局；空位只有 1 个 → clamp 补 1 AI
    rm.startGame(token);
    const aiSeat = room.seats[3];
    expect(aiSeat).not.toBeNull();
    expect(aiSeat?.isAI).toBe(true);
    expect(aiSeat?.nickname).toBe('AI-1（普通）');
    expect(aiSeat?.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(room.seats.filter((s) => s === null)).toHaveLength(0);
  });

  it('startGame：真人 + count < playerCount 仍拒绝（room-not-full）', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom(
      { playerCount: 4, aiSeats: { count: 1, difficulty: 'easy' } },
      'alice',
    );
    rm.joinRoom(room.code, 'bob');
    // 2 真人 + 1 AI = 3 < 4
    expect(() => rm.startGame(token)).toThrowError(
      expect.objectContaining({ code: 'room-not-full' }) as Error,
    );
  });

  it('startGame：满员真人房带 aiSeats 配置时填充 0 个 AI（min clamp 到下界）', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom(
      { playerCount: 2, aiSeats: { count: 1, difficulty: 'hard' } },
      'alice',
    );
    rm.joinRoom(room.code, 'bob');
    rm.startGame(token);
    expect(room.seats.every((s) => s !== null && !s.isAI)).toBe(true);
  });

  it('AI 昵称难度后缀：简单/普通/困难；多 AI 顺序编号', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom(
      { playerCount: 4, aiSeats: { count: 3, difficulty: 'easy' } },
      'alice',
    );
    rm.startGame(token);
    expect(room.seats[1]?.nickname).toBe('AI-1（简单）');
    expect(room.seats[2]?.nickname).toBe('AI-2（简单）');
    expect(room.seats[3]?.nickname).toBe('AI-3（简单）');
    const rm2 = new RoomManager();
    const { room: room2, token: token2 } = rm2.createRoom(
      { playerCount: 2, aiSeats: { count: 1, difficulty: 'hard' } },
      'alice',
    );
    rm2.startGame(token2);
    expect(room2.seats[1]?.nickname).toBe('AI-1（困难）');
  });

  it('AI token 永不进 tokenIndex：findByToken 不可达；真人 token 仍可达', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom(
      { playerCount: 2, aiSeats: { count: 1, difficulty: 'normal' } },
      'alice',
    );
    rm.startGame(token);
    const aiToken = room.seats[1]?.token;
    expect(aiToken).toBeDefined();
    expect(rm.findByToken(aiToken!)).toBeNull();
    expect(rm.findByToken(token)?.seat.seat).toBe(0);
  });

  it('aiSeats.specs 校验：长度不等于 count / 未知 spec 拒绝（invalid-config）', () => {
    const rm = new RoomManager();
    expect(() =>
      rm.createRoom(
        { playerCount: 4, aiSeats: { count: 2, difficulty: 'normal', specs: ['builtin:jsb-v20260902b'] } },
        'a',
      ),
    ).toThrowError(/specs 长度须等于 count/);
    expect(() =>
      rm.createRoom(
        { playerCount: 4, aiSeats: { count: 1, difficulty: 'normal', specs: ['builtin:no-such-agent'] } },
        'a',
      ),
    ).toThrowError(/未知 AI 插件 spec/);
    // 合法：每席位各自指定版本
    expect(() =>
      rm.createRoom(
        {
          playerCount: 4,
          aiSeats: {
            count: 2,
            difficulty: 'normal',
            specs: ['builtin:jsb-v20260902b', 'builtin:lm-heuristic-v20260829'],
          },
        },
        'a',
      ),
    ).not.toThrow();
  });

  it('AI 昵称插件版本后缀：指定 specs 时昵称带插件短名', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom(
      {
        playerCount: 4,
        aiSeats: {
          count: 3,
          difficulty: 'easy',
          specs: ['builtin:jsb-v20260902b', 'builtin:jsb-v20260901', 'builtin:lm-heuristic-v20260826'],
        },
      },
      'alice',
    );
    rm.startGame(token);
    expect(room.seats[1]?.nickname).toBe('AI-1（jsb-v20260902b）');
    expect(room.seats[2]?.nickname).toBe('AI-2（jsb-v20260901）');
    expect(room.seats[3]?.nickname).toBe('AI-3（lm-heuristic-v20260826）');
    // toRoomState 广播同样带 specs（大厅展示 AI 配置）
    const state = toRoomState(room);
    expect(state.config.aiSeats?.specs).toEqual([
      'builtin:jsb-v20260902b',
      'builtin:jsb-v20260901',
      'builtin:lm-heuristic-v20260826',
    ]);
  });

  it('toRoomState：config 含 aiSeats（仍不含 seed），AI 座位 isAI=true', () => {
    const rm = new RoomManager();
    const { room, token } = rm.createRoom(
      { playerCount: 2, seed: 42, aiSeats: { count: 1, difficulty: 'normal' } },
      'alice',
    );
    rm.startGame(token);
    const state = toRoomState(room);
    expect(state.config).toEqual({
      playerCount: 2,
      aiSeats: { count: 1, difficulty: 'normal' },
    });
    expect(JSON.stringify(state)).not.toContain('seed');
    expect(state.seats[0]).toEqual({
      seat: 0,
      nickname: 'alice',
      isAI: false,
      connected: true,
    });
    expect(state.seats[1]).toMatchObject({ seat: 1, isAI: true, connected: true });
    expect(JSON.stringify(state)).not.toContain('token');
  });

  it('toRoomState：无 aiSeats 时 config 保持 { playerCount }（不含 aiSeats 键）', () => {
    const rm = new RoomManager();
    const { room } = rm.createRoom({ playerCount: 2 }, 'alice');
    expect(toRoomState(room).config).toEqual({ playerCount: 2 });
  });
});

// ---------------------------------------------------------------------------
// WS 集成层
// ---------------------------------------------------------------------------

/** fixture agent：内部用 HeuristicAgent 选牌，记录 decide 调用次数。 */
class RecordingAgent implements DecidingAgent {
  calls = 0;
  private readonly inner = new HeuristicAgent();

  decide(state: GameState, player: PlayerIndex, legal: Action[]): Promise<Decision> {
    this.calls += 1;
    return this.inner.decide(state, player, legal);
  }
}

/** 首次 decide 抛非 API 异常（模拟 summarize/prescreen bug），之后正常。 */
class ThrowOnceAgent implements DecidingAgent {
  calls = 0;
  private readonly inner = new HeuristicAgent();

  decide(state: GameState, player: PlayerIndex, legal: Action[]): Promise<Decision> {
    this.calls += 1;
    if (this.calls === 1) {
      return Promise.reject(new Error('summarize bug boom（非 API 异常）'));
    }
    return this.inner.decide(state, player, legal);
  }
}

/** 门控 agent：open() 前所有 decide 悬挂（测并发守卫防重入）。 */
class GatedAgent implements DecidingAgent {
  calls = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((r) => {
    this.release = r;
  });
  private readonly inner = new HeuristicAgent();

  async decide(state: GameState, player: PlayerIndex, legal: Action[]): Promise<Decision> {
    this.calls += 1;
    await this.gate;
    return this.inner.decide(state, player, legal);
  }

  open(): void {
    this.release();
  }
}

interface WsPlayer {
  client: TestClient;
  token: string;
  rng: Rng;
}

interface SetupResult {
  server: GameServer;
  players: WsPlayer[];
  code: string;
}

/** 建房 + 真人入座 + 开局（可带 aiSeats 与 aiAgentFactory 注入缝）。 */
async function setupGame(opts: {
  playerCount: 2 | 3 | 4;
  humans: number;
  aiCount?: number;
  difficulty?: 'easy' | 'normal' | 'hard';
  seed?: number;
  aiAgentFactory?: (seat: PlayerIndex, difficulty: 'easy' | 'normal' | 'hard') => DecidingAgent;
}): Promise<SetupResult> {
  const server = await harness.startServer({
    ...(opts.aiAgentFactory !== undefined ? { aiAgentFactory: opts.aiAgentFactory } : {}),
  });
  const config: Record<string, unknown> = { playerCount: opts.playerCount };
  if (opts.seed !== undefined) config['seed'] = opts.seed;
  if (opts.aiCount !== undefined) {
    config['aiSeats'] = { count: opts.aiCount, difficulty: opts.difficulty ?? 'normal' };
  }
  const c0 = await harness.connect(server.port);
  const cred0 = await c0.send(
    { type: 'create_room', protocolVersion: PV, nickname: 'P0', config },
    'credentials',
  );
  const code = (await c0.nextMessage('room_state')).room.code as string;
  const players: WsPlayer[] = [{ client: c0, token: cred0.token as string, rng: createRng(7_000) }];
  for (let i = 1; i < opts.humans; i++) {
    const c = await harness.connect(server.port);
    const cred = await c.send(
      { type: 'join_room', protocolVersion: PV, code, nickname: `P${i}` },
      'credentials',
    );
    players.push({ client: c, token: cred.token as string, rng: createRng(7_000 + i) });
  }
  await c0.send({ type: 'start_game', protocolVersion: PV, token: players[0]!.token });
  return { server, players, code };
}

/**
 * 单个人类端驱动：每次等到"自己 legalActions 非空"的 snapshot 就随机行动；
 * 与 game_over 赛跑——对局结束即返回。game_over waiter 只注册一次（重复注册
 * 会让先到的孤儿 waiter 抢走消息，见 helpers 的"最早匹配"语义）。
 */
async function driveOneHuman(p: WsPlayer): Promise<void> {
  const overP = p.client.nextMessage('game_over', undefined, TURN_TIMEOUT_MS * 4).then(
    () => 'over' as const,
    () => 'over-timeout' as const,
  );
  // turnHold 协议:只在自己刚行动过之后才发 end_turn(别人的 hold 忽略)
  let justActed = false;
  for (;;) {
    const snapP = p.client
      .nextMessage(
        'snapshot',
        (m) => m.turnHold != null || (m.legalActions as unknown[]).length > 0,
        TURN_TIMEOUT_MS,
      )
      .then(
        (m) => ({ kind: 'snap' as const, m }),
        () => ({ kind: 'stuck' as const }),
      );
    const r = await Promise.race([snapP, overP]);
    if (r === 'over') return;
    if (r === 'over-timeout') throw new Error('等 game_over 超时');
    if (r.kind === 'stuck') throw new Error('等自己回合 snapshot 超时（对局卡死）');
    const m = r.m;
    if (m.turnHold != null) {
      if (justActed) {
        p.client.send({ type: 'end_turn', protocolVersion: PV, token: p.token });
        justActed = false;
      }
      continue;
    }
    const legal = m.legalActions as Record<string, unknown>[];
    p.client.send({
      type: 'submit_action',
      protocolVersion: PV,
      token: p.token,
      action: legal[p.rng.nextInt(legal.length)]!,
    });
    justActed = true;
  }
}

function driveHumansUntilGameOver(players: WsPlayer[]): Promise<void[]> {
  return Promise.all(players.map((p) => driveOneHuman(p)));
}

describe('WS 集成：AI 座位与驱动循环', () => {
  it('create_room 非法 aiSeats → error invalid-config', async () => {
    const server = await harness.startServer();
    const c = await harness.connect(server.port);
    c.send({
      type: 'create_room',
      protocolVersion: PV,
      nickname: 'a',
      config: { playerCount: 4, aiSeats: { count: 0, difficulty: 'normal' } },
    });
    const err = await c.nextMessage('error');
    expect(err.code).toBe('invalid-config');
  });

  it('room_state 广播：AI 座位 isAI=true，config 含 aiSeats（不含 seed）', async () => {
    const { players } = await setupGame({
      playerCount: 2,
      humans: 1,
      aiCount: 1,
      difficulty: 'normal',
      seed: 42,
      aiAgentFactory: () => new RecordingAgent(),
    });
    const rs = await players[0]!.client.nextMessage(
      'room_state',
      (m) => m.room.started === true,
    );
    expect(rs.room.config).toEqual({
      playerCount: 2,
      aiSeats: { count: 1, difficulty: 'normal' },
    });
    expect(rs.room.seats[1]).toMatchObject({ isAI: true, nickname: 'AI-1（普通）' });
    expect(JSON.stringify(rs.room)).not.toContain('seed');
    // credentials 只发给真人（seat 0），AI 座位永不下发 token
    const creds = players[0]!.client.received.filter((m) => m.type === 'credentials');
    expect(creds).toHaveLength(1);
    expect(creds[0]!.seat).toBe(0);
  });

  it(
    '2 真人 + 2 AI 完整对局：ai_thinking 成对、AI action_applied 带 reason、seq 连续',
    { timeout: 180_000 },
    async () => {
      const agents: RecordingAgent[] = [];
      const { players } = await setupGame({
        playerCount: 4,
        humans: 2,
        aiCount: 2,
        difficulty: 'normal',
        seed: 42,
        aiAgentFactory: () => {
          const a = new RecordingAgent();
          agents.push(a);
          return a;
        },
      });
      await driveHumansUntilGameOver(players);

      // 每个 AI 座位各经注入缝拿到一个 agent，且被实际驱动过
      expect(agents).toHaveLength(2);
      expect(agents[0]!.calls + agents[1]!.calls).toBeGreaterThan(0);

      for (const p of players) {
        const msgs = p.client.received;
        // ai_thinking：出现过 true 的座位必有对应 false（成对收尾）
        const thinking = msgs.filter((m) => m.type === 'ai_thinking');
        expect(thinking.length).toBeGreaterThan(0);
        const trues = new Set(thinking.filter((m) => m.thinking === true).map((m) => m.seat));
        const falses = thinking.filter((m) => m.thinking === false).map((m) => m.seat);
        for (const seat of trues) expect(falses).toContain(seat);
        // AI 座位（2/3）的 action_applied 带 reason；真人（0/1）不带
        const aiApplied = msgs.filter(
          (m) => m.type === 'action_applied' && (m.player === 2 || m.player === 3),
        );
        expect(aiApplied.length).toBeGreaterThan(0);
        for (const m of aiApplied) expect(typeof m.reason).toBe('string');
        // RecordingAgent 内嵌 HeuristicAgent：决策均为降级路径 → degraded 下发
        for (const m of aiApplied) expect(m.degraded).toBe(true);
        const humanApplied = msgs.filter(
          (m) => m.type === 'action_applied' && (m.player === 0 || m.player === 1),
        );
        expect(humanApplied.length).toBeGreaterThan(0);
        for (const m of humanApplied) expect(m.reason).toBeUndefined();
        for (const m of humanApplied) expect(m.degraded).toBeUndefined();
        // AI 行动走同一条落库/广播路径：seq 连续无重号
        const seqs = msgs.filter((m) => m.type === 'action_applied').map((m) => m.seq);
        expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i));
      }
    },
  );

  it(
    'driveAI 兜底：agent.decide 抛非 API 异常 → error 日志 + Heuristic 末级兜底，对局不卡死',
    { timeout: 180_000 },
    async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const agent = new ThrowOnceAgent();
      const { players } = await setupGame({
        playerCount: 2,
        humans: 1,
        aiCount: 1,
        difficulty: 'easy',
        seed: 7,
        aiAgentFactory: () => agent,
      });
      await driveHumansUntilGameOver(players);
      expect(agent.calls).toBeGreaterThan(0);
      // 末级兜底触发过：error 日志带 [ai] 前缀与原始异常
      const logged = errSpy.mock.calls.some(
        (args) =>
          typeof args[0] === 'string' &&
          args[0].includes('[ai]') &&
          String(args[1]).includes('summarize bug boom'),
      );
      expect(logged).toBe(true);
      // AI 至少一次行动由兜底产生（reason 含 heuristic 兜底标记）
      const aiApplied = players[0]!.client.received.filter(
        (m) => m.type === 'action_applied' && m.player === 1,
      );
      expect(aiApplied.length).toBeGreaterThan(0);
      expect(aiApplied.some((m) => String(m.reason).includes('heuristic'))).toBe(true);
      // 末级兜底行动标记 degraded（前端据此渲染"（已降级）"）
      const fallback = aiApplied.find((m) => String(m.reason).includes('末级兜底'));
      expect(fallback?.degraded).toBe(true);
    },
  );

  it(
    '并发守卫：AI 决策悬挂期间真人 resume 重触发 driveAI——decide 不重入（幂等）',
    { timeout: 120_000 },
    async () => {
      const agent = new GatedAgent();
      const { server, players } = await setupGame({
        playerCount: 2,
        humans: 1,
        aiCount: 1,
        difficulty: 'normal',
        seed: 11,
        aiAgentFactory: () => agent,
      });
      const human = players[0]!;
      // ai_thinking waiter 只注册一次（孤儿 waiter 会抢走消息，见 helpers 语义）
      const thinkingP = human.client.nextMessage(
        'ai_thinking',
        (m) => m.thinking === true,
        TURN_TIMEOUT_MS,
      );
      // 推进到 AI 首次决策悬挂：真人轮到自己就行动（首玩家可能是真人）
      for (let i = 0; i < 50; i++) {
        const snap = await human.client
          .nextMessage(
            'snapshot',
            (m) => (m.legalActions as unknown[]).length > 0,
            300,
          )
          .catch(() => null);
        if (snap === null) {
          // 本拍无真人回合：若 AI 已开始思考即可停
          if (human.client.received.some((m) => m.type === 'ai_thinking' && m.thinking)) break;
          continue;
        }
        const legal = snap.legalActions as Record<string, unknown>[];
        human.client.send({
          type: 'submit_action',
          protocolVersion: PV,
          token: human.token,
          action: legal[0]!,
        });
        // turnHold 协议:回合打满被扣住 → 显式结束回合
        const post = await human.client
          .nextMessage('snapshot', (m) => m.turnHold != null, 300)
          .catch(() => null);
        if (post !== null) {
          human.client.send({ type: 'end_turn', protocolVersion: PV, token: human.token });
        }
      }
      await thinkingP; // AI 决策已悬挂（gate 未开）
      expect(agent.calls).toBe(1);
      // resume 重触发 driveAI：新连接带真人 token resume（守卫应防重入）
      const c2 = await harness.connect(server.port);
      c2.send({ type: 'resume', protocolVersion: PV, token: human.token });
      await c2.nextMessage('credentials');
      expect(agent.calls).toBe(1);
      agent.open();
      // 对局继续走完（旧连接已被 resume 踢掉，用新连接驱动）
      await driveOneHuman({ client: c2, token: human.token, rng: createRng(9_999) });
      expect(agent.calls).toBeGreaterThan(1);
    },
  );

  it(
    '缺 aiAgentFactory（ANTHROPIC_API_KEY 缺失降级路径）：默认 HeuristicAgent 驱动完整对局',
    { timeout: 180_000 },
    async () => {
      const { players } = await setupGame({
        playerCount: 2,
        humans: 1,
        aiCount: 1,
        difficulty: 'normal',
        seed: 99,
      });
      await driveHumansUntilGameOver(players);
      const aiApplied = players[0]!.client.received.filter(
        (m) => m.type === 'action_applied' && m.player === 1,
      );
      expect(aiApplied.length).toBeGreaterThan(0);
      for (const m of aiApplied) expect(typeof m.reason).toBe('string');
    },
  );

  it(
    '广播加固：send 在连接过渡态同步抛错时 driveAI 完整跑完（无 unhandled rejection）',
    { timeout: 180_000 },
    async () => {
      // 模拟 terminate 未 close 处理窗口的症状：ws.send 同步抛（readyState 检查
      // 与底层 socket 写之间状态已过渡）。只拦 ai_thinking 载荷，action_applied/
      // snapshot 正常放行，人类驱动不受影响。
      const originalSend = WebSocket.prototype.send;
      let thrown = 0;
      vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
        this: WebSocket,
        data: unknown,
        ...rest: unknown[]
      ) {
        if (typeof data === 'string' && data.includes('"ai_thinking"')) {
          thrown += 1;
          throw new Error('simulated transition-state send failure');
        }
        return Reflect.apply(originalSend, this, [data, ...rest]) as void;
      });
      const agent = new RecordingAgent();
      const { players } = await setupGame({
        playerCount: 2,
        humans: 1,
        aiCount: 1,
        difficulty: 'normal',
        seed: 3,
        aiAgentFactory: () => agent,
      });
      await driveHumansUntilGameOver(players);
      // 加固路径确实被走过，且 AI 走的是正常决策路径（非末级兜底）
      expect(thrown).toBeGreaterThan(0);
      expect(agent.calls).toBeGreaterThan(0);
    },
  );

  it(
    '真人连接被 terminate（未 close 处理）后对局继续：resume 接管座位并打完',
    { timeout: 180_000 },
    async () => {
      const { server, players } = await setupGame({
        playerCount: 3,
        humans: 2,
        aiCount: 1,
        difficulty: 'easy',
        seed: 21,
        aiAgentFactory: () => new RecordingAgent(),
      });
      // 粗暴断开 seat 0（无 close 握手），随后用同 token resume 接管
      players[0]!.client.ws.terminate();
      const c = await harness.connect(server.port);
      c.send({ type: 'resume', protocolVersion: PV, token: players[0]!.token });
      const cred = await c.nextMessage('credentials');
      expect(cred.seat).toBe(0);
      await driveHumansUntilGameOver([
        { client: c, token: players[0]!.token, rng: createRng(5_000) },
        players[1]!,
      ]);
    },
  );
});
