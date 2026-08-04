/**
 * 测试共享 helper：TestClient（类型过滤缓冲队列）+ 服务器/客户端生命周期 harness。
 *
 * 防 flake 核心：每连接一个"类型过滤缓冲队列"——nextMessage(type, pred?) 先扫已收队列取
 * 最早的匹配消息，未匹配则挂等待；广播时序（room_state/snapshot/action_applied 交错）不再
 * 依赖到达顺序假设。
 */
import { WebSocket } from 'ws';
import { createGameServer, type GameServer, type GameServerOptions } from '../src/ws.js';

/** 收到的协议消息（测试里宽松看待字段）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Msg = { type: string; [k: string]: any };

interface Waiter {
  pred: (m: Msg) => boolean;
  resolve: (m: Msg) => void;
  timer: NodeJS.Timeout;
}

export class TestClient {
  readonly received: Msg[] = [];
  private readonly queue: Msg[] = [];
  private readonly waiters: Waiter[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Msg;
      this.received.push(msg);
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx === -1) {
        this.queue.push(msg);
        return;
      }
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
    });
  }

  static async connect(
    port: number,
    path = '/ws',
    options?: { autoPong?: boolean },
  ): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      autoPong: options?.autoPong ?? true,
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    return new TestClient(ws);
  }

  /** 发消息；给 awaitType 时等该类型的最早匹配消息。 */
  send(msg: Record<string, unknown>): void;
  send(msg: Record<string, unknown>, awaitType: string): Promise<Msg>;
  send(msg: Record<string, unknown>, awaitType?: string): void | Promise<Msg> {
    this.ws.send(JSON.stringify(msg));
    if (awaitType === undefined) return;
    return this.nextMessage(awaitType);
  }

  /** 取指定类型（可再加谓词）的最早消息；已收队列优先，否则等待。 */
  nextMessage(type: string, pred?: (m: Msg) => boolean, timeoutMs = 5000): Promise<Msg> {
    const matches = (m: Msg): boolean => m.type === type && (pred === undefined || pred(m));
    const idx = this.queue.findIndex(matches);
    if (idx !== -1) return Promise.resolve(this.queue.splice(idx, 1)[0]!);
    return new Promise<Msg>((resolve, reject) => {
      const waiter: Waiter = {
        pred: matches,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i !== -1) this.waiters.splice(i, 1);
          reject(
            new Error(
              `等待 ${type} 超时；已收类型: ${this.received.map((m) => m.type).join(',') || '(无)'}`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  waitClose(timeoutMs = 3000): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitClose 超时')), timeoutMs);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = this.waitClose();
    this.ws.close();
    await closed;
  }
}

/** 服务器/客户端注册表：afterEach 里 cleanup 统一回收，防跨用例泄漏。 */
export interface TestHarness {
  startServer(extra?: Partial<GameServerOptions>): Promise<GameServer>;
  connect(port: number, options?: { autoPong?: boolean }): Promise<TestClient>;
  cleanup(): Promise<void>;
}

export function createTestHarness(): TestHarness {
  const servers: GameServer[] = [];
  const clients: TestClient[] = [];
  return {
    async startServer(extra) {
      const server = await createGameServer({ port: 0, dbPath: ':memory:', ...extra });
      servers.push(server);
      return server;
    },
    async connect(port, options) {
      const client = await TestClient.connect(port, '/ws', options);
      clients.push(client);
      return client;
    },
    async cleanup() {
      await Promise.all(servers.splice(0).map((s) => s.close()));
      await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
    },
  };
}
