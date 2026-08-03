/**
 * 对局状态 store（M2 Task 10）：ws 薄封装 GameClient + 手写 store（useSyncExternalStore，
 * 不引 redux/zustand）。
 *
 * 断线语义（对齐 server ws.ts）：
 * - 同 token resume 会踢掉旧连接——服务器主动 close，无 connected=false 广播。本端被动
 *   close 一律视为可恢复断线：延时重连，持 token 时连上自动发 resume。
 * - disconnect() 为主动关闭（置 intentionalClose），不触发自动重连，并取消等待中的
 *   重连定时器。
 *
 * 日志：action_applied 流环形缓冲，保留最新 LOG_CAPACITY 条。
 */
import { useSyncExternalStore } from 'react';
import { PROTOCOL_VERSION } from '@brass/protocol';
import type {
  ClientMessage,
  FilteredState,
  RoomConfig,
  RoomState,
  ServerMessage,
} from '@brass/protocol';
import type { Action, PlayerIndex } from '@brass/engine';

// WebSocket.readyState 数值常量（CONNECTING/OPEN），避免依赖全局 WebSocket。
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/** 可注入的 ws 最小接口：原生 WebSocket 结构兼容（默认工厂处强转）。 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultFactory: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

/**
 * 浏览器 ws 薄封装。构造传 url + 可选 WebSocketFactory（测试注入 fake）。
 * 事件走 onMessage/onOpen/onClose 订阅（返回退订函数）；消息帧 JSON 解析失败即丢弃。
 */
export class GameClient {
  private ws: WebSocketLike | null = null;
  private readonly messageHandlers = new Set<(msg: ServerMessage) => void>();
  private readonly openHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly factory: WebSocketFactory = defaultFactory,
  ) {}

  /** 建连；已 connecting/open 时幂等。 */
  connect(): void {
    if (
      this.ws !== null &&
      (this.ws.readyState === WS_CONNECTING || this.ws.readyState === WS_OPEN)
    ) {
      return;
    }
    const ws = this.factory(this.url);
    this.ws = ws;
    ws.onopen = () => {
      for (const cb of this.openHandlers) cb();
    };
    ws.onclose = () => {
      for (const cb of this.closeHandlers) cb();
    };
    ws.onerror = () => {
      // close 事件随后统一处理
    };
    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return; // 非法帧丢弃
      }
      for (const cb of this.messageHandlers) cb(msg);
    };
  }

  /** 未 open 时抛错（调用方应等 connected 后再发）。 */
  send(msg: ClientMessage): void {
    if (this.ws === null || this.ws.readyState !== WS_OPEN) {
      throw new Error('WebSocket 未连接');
    }
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws?.close();
  }

  onMessage(cb: (msg: ServerMessage) => void): () => void {
    this.messageHandlers.add(cb);
    return () => {
      this.messageHandlers.delete(cb);
    };
  }

  onOpen(cb: () => void): () => void {
    this.openHandlers.add(cb);
    return () => {
      this.openHandlers.delete(cb);
    };
  }

  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb);
    return () => {
      this.closeHandlers.delete(cb);
    };
  }
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

/** action_applied 日志条目（events 原样保留，面板层可自行展开）。 */
export interface LogEntry {
  seq: number;
  player: PlayerIndex;
  action: Action;
  events: unknown[];
}

export interface GameOverInfo {
  winner: PlayerIndex[];
  finalScores: number[];
}

export interface GameStoreState {
  connection: ConnectionStatus;
  room: RoomState | null;
  /** 本人座位（room_state.yourSeat / credentials.seat）。 */
  seat: PlayerIndex | null;
  /** credentials 下发的 token；断线重连后自动 resume 的凭据。 */
  token: string | null;
  snapshot: FilteredState | null;
  legalActions: Action[];
  /** 最近一次 snapshot 的 seq。 */
  seq: number;
  log: LogEntry[];
  gameOver: GameOverInfo | null;
  lastError: { code: string; message: string } | null;
  selectedCard: string | null;
}

export const LOG_CAPACITY = 100;

const INITIAL_STATE: GameStoreState = {
  connection: 'disconnected',
  room: null,
  seat: null,
  token: null,
  snapshot: null,
  legalActions: [],
  seq: 0,
  log: [],
  gameOver: null,
  lastError: null,
  selectedCard: null,
};

export interface GameStoreOptions {
  /** 被动断线后的重连延时，默认 1000ms（测试传 0）。 */
  reconnectDelayMs?: number;
}

export class GameStore {
  private state: GameStoreState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs: number;

  constructor(
    private readonly client: GameClient,
    options: GameStoreOptions = {},
  ) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    client.onMessage((msg) => this.handleMessage(msg));
    client.onOpen(() => this.handleOpen());
    client.onClose(() => this.handleClose());
  }

  getState = (): GameStoreState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** 主动建连（也用于自动重连）。 */
  connect(): void {
    this.intentionalClose = false;
    this.clearReconnectTimer();
    this.patch({ connection: 'connecting' });
    this.client.connect();
  }

  /** 主动断开：不自动重连。 */
  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.client.close();
    this.patch({ connection: 'disconnected' });
  }

  createRoom(nickname: string, config: RoomConfig): void {
    this.send({ type: 'create_room', protocolVersion: PROTOCOL_VERSION, nickname, config });
  }

  joinRoom(code: string, nickname: string): void {
    this.send({ type: 'join_room', protocolVersion: PROTOCOL_VERSION, code, nickname });
  }

  startGame(): void {
    this.send({
      type: 'start_game',
      protocolVersion: PROTOCOL_VERSION,
      token: this.requireToken(),
    });
  }

  /** 提交行动并清空选牌（行动消耗一张卡）。 */
  submitAction(action: Action): void {
    this.send({
      type: 'submit_action',
      protocolVersion: PROTOCOL_VERSION,
      token: this.requireToken(),
      action,
    });
    this.patch({ selectedCard: null });
  }

  selectCard(cardId: string | null): void {
    this.patch({ selectedCard: cardId });
  }

  private requireToken(): string {
    if (this.state.token === null) {
      throw new Error('尚无 credentials token——先 create/join/resume');
    }
    return this.state.token;
  }

  private send(msg: ClientMessage): void {
    this.client.send(msg);
  }

  /** 连上：若持 token（曾入房/入过对局）自动 resume 抢回座位。 */
  private handleOpen(): void {
    this.patch({ connection: 'connected' });
    if (this.state.token !== null) {
      this.client.send({
        type: 'resume',
        protocolVersion: PROTOCOL_VERSION,
        token: this.state.token,
      });
    }
  }

  /** 被动 close（含同 token 被踢）：一律安排自动重连。 */
  private handleClose(): void {
    if (this.intentionalClose) return;
    this.patch({ connection: 'disconnected' });
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'room_state':
        this.patch({ room: msg.room, seat: msg.yourSeat });
        break;
      case 'credentials':
        this.patch({ token: msg.token, seat: msg.seat });
        break;
      case 'snapshot':
        this.patch({
          snapshot: msg.state,
          legalActions: msg.legalActions,
          seq: msg.seq,
        });
        break;
      case 'action_applied': {
        const entry: LogEntry = {
          seq: msg.seq,
          player: msg.player,
          action: msg.action,
          events: msg.events,
        };
        this.patch({ log: [...this.state.log, entry].slice(-LOG_CAPACITY) });
        break;
      }
      case 'game_over':
        this.patch({ gameOver: { winner: msg.winner, finalScores: msg.finalScores } });
        break;
      case 'error':
        this.patch({ lastError: { code: msg.code, message: msg.message } });
        break;
      case 'pong':
        break;
    }
  }

  /** 不可变更新：每次产生新 state 对象，useSyncExternalStore 靠引用比较触发渲染。 */
  private patch(partial: Partial<GameStoreState>): void {
    this.state = { ...this.state, ...partial };
    for (const cb of this.listeners) cb();
  }
}

/** React 绑定：订阅整个 store 状态。 */
export function useGameStore(store: GameStore): GameStoreState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
