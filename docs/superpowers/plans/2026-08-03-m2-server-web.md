# M2 可玩（server + web）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 真人在浏览器里创建/加入房间，完整下一局 Brass: Birmingham——权威 WebSocket 服务器 + SQLite 持久化 + 最小可用 React 前端。

**Architecture:** 新增三个 workspace 包：`packages/protocol`（零依赖，WS 消息类型 + 视角过滤）、`packages/server`（ws + Drizzle/better-sqlite3，房间管理 + 权威裁决 + 广播）、`packages/web`（Vite + React + 自绘 SVG 棋盘）。规则只在 engine 结算；server 调 engine，web 只渲染与构造行动。

**Tech Stack:** TypeScript strict、ws、drizzle-orm + better-sqlite3、React 18 + Vite、Vitest、GitHub Actions。

**上游契约（M1 engine，已合 main）：** `newGame(playerCount, seed): GameState`、`enumerateActions(state, player): Action[]`、`applyAction(state, action): GameState`（非法抛 `IllegalActionError`）、`GameState.turnOrder/currentPlayerIdx/lastEvents/phase/winner`。注意：`enumerateActions` 不校验 player 是否当前玩家——server 必须传 `turnOrder[currentPlayerIdx]`。

## Global Constraints

- 规则只在 `packages/engine` 结算；本计划**不得修改 engine 源码**（发现 engine bug 时停下上报，不绕过）
- 新增 package 必须同步 CI（.github/workflows/ci.yml 的 typecheck+test 已是 workspaces 聚合——确认覆盖即可，覆盖率豁免配置各包自理）
- WS 协议带 `protocolVersion: 1` 字段；消息全部 JSON
- 权威服务器：客户端永不本地推进状态；服务器按座位过滤快照（其他人手牌只有数量；deck/discard 只发数量）
- 合法行动由**服务器**随快照下发（`legalActions`）——设计文档 §7 的"浏览器本地预检"以本计划为准（设计文档已同步修订）
- 落库：对局 = newGame 种子 + action log（games/actions/seats 三表）
- Git 工作流：禁直推 main；分支 feat/m2-*；commit 带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` 尾注
- 每个 commit 前根目录 `npm run typecheck && npm test` 全绿

---

### Task 1: protocol 包 + server 脚手架 + CI 确认

**Files:**
- Create: `packages/protocol/package.json`、`tsconfig.json`、`src/index.ts`
- Create: `packages/server/package.json`、`tsconfig.json`、`vitest.config.ts`、`src/index.ts`（占位）
- Modify: `.github/workflows/ci.yml`（确认 workspaces 聚合覆盖新包；注释说明）
- Test: `packages/protocol/test/protocol.test.ts`

**Interfaces:**
- Produces（全 M2 依赖的消息类型，packages/protocol/src/index.ts）：

```ts
import type { Action, GameState, PlayerIndex } from '@brass/engine';

export const PROTOCOL_VERSION = 1;

// 房间配置与大厅
export interface RoomConfig { playerCount: 2|3|4; seed?: number }
export interface SeatInfo { seat: PlayerIndex; nickname: string; isAI: boolean; connected: boolean }
export interface RoomState { code: string; config: RoomConfig; seats: (SeatInfo|null)[]; started: boolean }

// 下行
export type ServerMessage =
  | { type: 'room_state'; protocolVersion: number; room: RoomState; yourSeat: PlayerIndex | null } // 广播安全：绝不含 token
  | { type: 'credentials'; protocolVersion: number; seat: PlayerIndex; token: string } // 仅 create/join/resume 时单发给本人
  | { type: 'snapshot'; protocolVersion: number; seq: number; state: FilteredState; legalActions: Action[] }
  | { type: 'action_applied'; protocolVersion: number; seq: number; player: PlayerIndex; action: Action; events: unknown[] }
  | { type: 'game_over'; protocolVersion: number; winner: PlayerIndex[]; finalScores: number[] } // finalScores = 终局 state.players[].vp 按座位序
  | { type: 'error'; protocolVersion: number; code: string; message: string }
  | { type: 'pong'; protocolVersion: number };

// FilteredState = GameState 视角过滤（Task 2 定义精确形状）
export type FilteredState = unknown; // Task 2 替换为精确类型

// 上行
export type ClientMessage =
  | { type: 'create_room'; protocolVersion: number; nickname: string; config: RoomConfig }
  | { type: 'join_room'; protocolVersion: number; code: string; nickname: string }
  | { type: 'start_game'; protocolVersion: number; token: string }
  | { type: 'submit_action'; protocolVersion: number; token: string; action: Action }
  | { type: 'resume'; protocolVersion: number; token: string }
  | { type: 'ping'; protocolVersion: number };
```

- server 脚手架：devDeps ws/@types/ws + drizzle-orm + better-sqlite3（deps）；scripts 同 engine（test/typecheck）

- [ ] **Step 1: 写 protocol 类型 + 编译测试**（类型导出存在性、PROTOCOL_VERSION===1 的断言测试；**断言 room_state 类型无 token 字段——广播安全**）
- [ ] **Step 2: `npm install --registry=https://registry.npmmirror.com`（网络环境要求；lock 域名与既有 npmjs.org 混用无害，npm ci 两边均可），生成 lock**
- [ ] **Step 3: typecheck + test 绿，确认根 `npm test --workspaces` 覆盖两个新包；CI job 名由 engine 改为 build-test（聚合后名符其实）**
- [ ] **Step 4: Commit** — `git commit -m "feat(protocol,server): M2 脚手架与 WS 消息类型"`

---

### Task 2: 视角过滤（FilteredState）

**Files:**
- Modify: `packages/protocol/src/index.ts`（FilteredState 精确化）
- Create: `packages/protocol/src/filter.ts`
- Test: `packages/protocol/test/filter.test.ts`

**Interfaces:**
- Consumes: engine GameState/Card
- Produces:
  - `filterStateFor(state: GameState, viewer: PlayerIndex): FilteredState`
  - FilteredState 形状：与 GameState 同构，但 (a) 其他玩家 `hand` 替换为 `{ count: number }`；(b) `deck` 替换为 `{ count: number }`；(c) `discard` 替换为 `{ count: number; top?: Card }`（弃牌堆顶公开）；(d) `rngState` 字段移除（防推算洗牌）。viewer 自己的 hand 完整。**类型上用判别联合表达手牌两种形态：**

```ts
export type HandView = { kind: 'full'; cards: Card[] } | { kind: 'count'; count: number };
export type FilteredPlayerState = Omit<PlayerState, 'hand'> & { hand: HandView };
export type FilteredState = Omit<GameState, 'players'|'deck'|'discard'|'rngState'> & {
  players: FilteredPlayerState[];
  deck: { count: number };
  discard: { count: number; top: Card | null };
};
```

- [ ] **Step 1: 失败测试**

```ts
import { newGame } from '@brass/engine';
import { filterStateFor } from '../src/filter.js';

it('viewer sees own hand, others only counts', () => {
  const s = newGame(4, 42);
  const f = filterStateFor(s, 0) as never as { players: { hand: { kind: string; cards?: unknown[]; count?: number } }[] };
  expect(f.players[0]!.hand.kind).toBe('full');
  expect(f.players[0]!.hand.cards).toHaveLength(8);
  for (let i = 1; i < 4; i++) {
    expect(f.players[i]!.hand.kind).toBe('count');
    expect(f.players[i]!.hand.count).toBe(8);
    expect(f.players[i]!.hand.cards).toBeUndefined();
  }
});
it('deck/discard are counts; rngState stripped; JSON-serializable', () => {
  const s = newGame(4, 42);
  const f = JSON.parse(JSON.stringify(filterStateFor(s, 0)));
  expect(f.deck.count).toBe(31);
  expect(f.discard.count).toBe(1);
  expect(f.rngState).toBeUndefined();
});
it('filtering does not mutate original state', () => {
  const s = newGame(4, 42);
  const before = JSON.stringify(s);
  filterStateFor(s, 0);
  expect(JSON.stringify(s)).toBe(before);
});
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → Commit** — `git commit -m "feat(protocol): 按座位视角过滤"`

---

### Task 3: 持久化层（Drizzle + better-sqlite3）

**Files:**
- Create: `packages/server/src/db/schema.ts`、`packages/server/src/db/repo.ts`
- Test: `packages/server/test/repo.test.ts`

**Interfaces:**
- Produces:
  - 表：`games(id TEXT PK, room_code TEXT, player_count INT, seed INT, config TEXT(json), status TEXT('playing'|'finished'), created_at INT, final_state TEXT(json) NULL)`；`actions(id INTEGER PK AUTOINCREMENT, game_id TEXT, seq INT, player INT, action TEXT(json))`；`seats(game_id TEXT, seat INT, nickname TEXT, token TEXT, PRIMARY KEY(game_id, seat), UNIQUE(token))`
  - **token 生命周期**：join 时由 RoomManager 内存签发（开局前 resume 走内存）；startGame 时随 createGame 落库（开局后 resume 查库）
  - **声明：服务器重启即丢进行中的对局（内存房间/会话不恢复）——重放恢复属 M5**
  - `openDb(path: string): Db`（`:memory:` 支持，测试用）
  - `createGame(db, {id, roomCode, playerCount, seed, config, seats: {seat, nickname, token}[]}): void`
  - `appendAction(db, gameId, seq, player, action): void`
  - `finishGame(db, gameId, finalState): void`
  - `listGames(db): {id, roomCode, playerCount, status, createdAt}[]`
  - `findSeatByToken(db, token): {gameId, seat} | null`
  - `listActions(db, gameId): {seq, player, action}[]`（按 seq 升序；Task 5 重放校验用）

- [ ] **Step 1: 失败测试**（内存库：createGame + appendAction + finishGame + listGames + findSeatByToken 往返；seq 唯一约束冲突抛错）
- [ ] **Step 2–5: 失败 → 实现 → 通过 → Commit** — `git commit -m "feat(server): SQLite 持久化层（games/actions/seats）"`

---

### Task 4: 房间管理器（RoomManager）

**Files:**
- Create: `packages/server/src/rooms.ts`
- Test: `packages/server/test/rooms.test.ts`

**Interfaces:**
- Produces:
  - `class RoomManager { createRoom(config, nickname): {room, seat, token}; joinRoom(code, nickname): {room, seat, token}; startGame(token): GameSession（Task 5 类型，此处可先返回 room）; getRoom(code): Room | null }`
  - 房间号：6 位大写字母数字（去混淆字符 0O1IL），冲突重试
  - token：随机 24 字符 base64url（**随机性用 node:crypto randomBytes——server 不受引擎种子约束**）
  - 大厅规则：createRoom 者为 seat 0；join 顺序补位；满员拒绝（error code 'room-full'）；房间不存在 'room-not-found'；started 后拒绝 join（'already-started'）；只有座位成员可 startGame（'not-in-room'）；人数不满也可开始（AI 座位是 M3 的事，M2 要求满员才能开始——**裁决：M2 startGame 要求 seats 满员**，简化）
  - 昵称：1-16 字符，房间内存活性校验即可

- [ ] **Step 1: 失败测试**（建房/加入/满员/错码/重复开始/token 唯一性/房间号字符集）
- [ ] **Step 2–5: 失败 → 实现 → 通过 → Commit** — `git commit -m "feat(server): 房间管理器"`

---

### Task 5: 对局会话（GameSession）

**Files:**
- Create: `packages/server/src/session.ts`
- Test: `packages/server/test/session.test.ts`

**Interfaces:**
- Consumes: engine、repo、filter
- Produces:
  - `class GameSession { constructor(db, gameId, playerCount, seed, seats); submitAction(seat, action): { seq } | throws SessionError; snapshotFor(seat): { seq, state: FilteredState, legalActions: Action[] }; get finished(): boolean; get currentSeat(): PlayerIndex }`
  - 权威裁决：`applyAction(engine)` 推进；**校验 seat === turnOrder[currentPlayerIdx]**（'not-your-turn'）；engine 的 IllegalActionError 透传 code
  - 每步：appendAction 落库（seq 从 0 递增）；终局 finishGame 落 final_state
  - `legalActions`：仅当 seat 是当前玩家时非空数组
  - SessionError 带 code（'not-your-turn' / engine 原 code / 'game-finished'）

- [ ] **Step 1: 失败测试**

```ts
it('full random game through session persists every action', () => {
  const db = openDb(':memory:');
  const sess = new GameSession(db, 'g1', 4, 42, seats4);
  const rng = createRng(1);
  while (!sess.finished) {
    const snap = sess.snapshotFor(sess.currentSeat);
    const a = snap.legalActions[rng.nextInt(snap.legalActions.length)]!;
    sess.submitAction(sess.currentSeat, a);
  }
  const rows = listActions(db, 'g1');
  expect(rows.length).toBeGreaterThan(100);
  expect(rows[0]!.seq).toBe(0);
  // 重放：log 与 final_state 一致
});
it('rejects out-of-turn and illegal actions with codes', () => { /* 'not-your-turn' + 引擎 code 透传 */ });
it('legalActions empty for non-current players', () => { ... });
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → Commit** — `git commit -m "feat(server): 权威对局会话（落库+视角快照）"`

---

### Task 6: WebSocket 传输层 + 集成测试

**Files:**
- Create: `packages/server/src/ws.ts`、`packages/server/src/main.ts`
- Test: `packages/server/test/ws.test.ts`

**Interfaces:**
- Consumes: RoomManager/GameSession/protocol
- Produces:
  - `createGameServer({ port, dbPath, staticDir? }): { close(): Promise<void> }`——**结构：http.createServer + ws.Server({ noServer })**；upgrade 只接受路径 `/ws`（其余 426/404）；`staticDir` 存在时同一 http.Server 托管静态文件（生产单端口：静态 + /ws 共端口）；dev 时不起 staticDir，vite proxy 转发 /ws
  - main.ts：读 `PORT`（默认 8420）、`DB_PATH`（默认 ./brass.db）、`WEB_DIST`（存在则托管）启动
  - 行为：连接即收消息路由；create_room/join_room 回 room_state（**广播版，无 token**）+ 单发 credentials（seat+token 仅本人）；start_game 后向全房间发 snapshot；submit_action 成功广播 action_applied + 每人视角 snapshot；非法回 error（code 透传）；resume(token) 重连回原座位（回 credentials + snapshot + room_state）；断线标记 connected=false 广播 room_state
  - 心跳：30s ping/pong（ws 库自带 pong；server 端 interval 检活，60s 无响应断开）

- [ ] **Step 1: 失败测试**（真实 ws 客户端，随机端口。**测试 helper 必须为每连接实现"类型过滤的缓冲队列"**：`nextMessage(type)` 从队列取匹配的最早消息，不匹配的入队等待——否则广播时序必 flake）：

```ts
it('two clients create/join/start/play one action', async () => {
  const { port } = await startTestServer();
  const a = await client(port), b = await client(port);
  const credA = await a.send({ type: 'create_room', protocolVersion: 1, nickname: 'A', config: { playerCount: 2, seed: 7 } }, 'credentials');
  const roomA = await a.nextMessage('room_state');
  const code = roomA.room.code;
  await b.send({ type: 'join_room', protocolVersion: 1, code, nickname: 'B' }, 'credentials');
  await a.send({ type: 'start_game', protocolVersion: 1, token: credA.token });
  const snap = await a.nextMessage('snapshot');
  expect(snap.legalActions.length).toBeGreaterThan(0);
  await a.send({ type: 'submit_action', protocolVersion: 1, token: credA.token, action: snap.legalActions[0] });
  const applied = await b.nextMessage('action_applied');
  expect(applied.seq).toBe(0);
});
it('room_state never carries tokens (broadcast safety)', async () => {
  // 收 b 的 room_state 序列化后不含 'token' 字段名
});
it('resume returns seat and snapshot after disconnect', async () => { /* 断线重连 */ });
it('protocolVersion mismatch gets error', async () => { ... });
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → Commit** — `git commit -m "feat(server): WebSocket 传输层与断线重连"`

---

### Task 7: 服务器端到端（ws 级完整对局）

**Files:**
- Test: `packages/server/test/e2e.test.ts`

- [ ] **Step 1: 写 e2e 测试**：4 个 ws 客户端建房打完整局（各座位收到 snapshot 后用独立 RNG 选 legalActions[随机]），直至 game_over；断言：每客户端收到的 action_applied seq 连续无重号、终局 games 表 status='finished'、final_state 存在、actions 行数 = seq 总数、不同座位 snapshot 中他人手牌不可见
- [ ] **Step 2: 跑到绿（超时 120s；慢则减为 2p）**
- [ ] **Step 3: Commit** — `git commit -m "test(server): ws 级完整对局 e2e"`

---

### Task 8: web 脚手架（Vite + React）+ 服务器静态托管

**Files:**
- Create: `packages/web/`（Vite React-TS 模板精简版：index.html、vite.config.ts、vitest.config.ts、src/main.tsx、src/App.tsx）
- Modify: `packages/server/src/main.ts`（生产模式托管 web/dist 静态文件；dev 由 vite proxy 转发 /ws）
- Test: `packages/web/src/smoke.test.tsx`（App 渲染冒烟，vitest + jsdom）

**Interfaces:**
- Produces: `npm run dev -w @brass/web`（vite dev，proxy /ws → localhost:8420）；`npm run build -w @brass/web`
- web devDeps：react/react-dom/vite/@vitejs/plugin-react/jsdom/@testing-library/react

- [ ] **Step 1: 脚手架 + 冒烟测试失败→通过**
- [ ] **Step 2: Commit** — `git commit -m "feat(web): Vite+React 脚手架与静态托管"`

---

### Task 9: 棋盘坐标数据 + SVG 棋盘组件

**Files:**
- Create: `packages/web/src/board/layout.ts`
- Create: `packages/web/src/board/BoardSvg.tsx`
- Test: `packages/web/src/board/layout.test.ts`

**Interfaces:**
- Produces:
  - `LAYOUT: Record<string, { x: number; y: number }>`——22 地点 + 5 商人位，画布 1000×760，按真实地理投影（见下表，实现时抄录）
  - `<BoardSvg state={FilteredState} highlights={...} onSlotClick onLinkClick />`：城市圆点+名称、产业槽位（矩形，图标=产业色块字母）、连接边（运河蓝/铁路棕，已建显示玩家色）、商人位（六边形）

坐标表（x,y 像素，实现时抄录——按真实地理位置归一化）：

```
stoke-on-trent (95,55)   leek (180,30)        belper (300,25)   derby (310,85)
stone (140,130)          uttoxeter (245,140)  burton-on-trent (330,185)
stafford (85,205)        cannock (150,245)    tamworth (310,265)
wolverhampton (95,320)   walsall (195,300)    nuneaton (395,285)
coalbrookdale (30,290)   dudley (95,395)      birmingham (215,390)  coventry (380,380)
kidderminster (60,480)   worcester (105,580)  redditch (215,505)
farm-north (95,150)      farm-south (55,530)
merchant: warrington (95,5) shrewsbury (5,240) nottingham (395,85) gloucester (60,690) oxford (330,640)
```

- [ ] **Step 1: 失败测试**（layout 覆盖全部 LOCATIONS/MERCHANTS key、坐标在画布内、无重叠 < 30px）
- [ ] **Step 2: BoardSvg 渲染（组件测试：渲染出 22 城市 group、39 边 line/path）**
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 棋盘坐标与 SVG 棋盘"`

---

### Task 10: 对局状态store + 信息面板

**Files:**
- Create: `packages/web/src/game/store.ts`（ws 客户端 + 状态机）
- Create: `packages/web/src/game/Panels.tsx`（市场/收入轨/顺位/日志/手牌）
- Test: `packages/web/src/game/store.test.ts`

**Interfaces:**
- Consumes: protocol 类型
- Produces:
  - `class GameClient { connect(url): void; onMessage(cb); send(msg: ClientMessage); }`（浏览器 ws 薄封装，可注入 mock 测试）
  - `useGameStore`：轻量手写 store（不引 redux/zustand——`useSyncExternalStore`）：room/snapshot/legalActions/seq/log/selectedCard
  - 面板组件：CoalIronMarket（需求轨+价格）、IncomeTrack（各人位置）、TurnOrderBar（顺位+当前高亮+各人 VP/现金/已花）、HandBar（自己手牌，wild 角标）、LogPanel（action_applied 流）

- [ ] **Step 1: store 单测（mock ws：消息 → 状态迁移；snapshot 更新 legalActions；断线显示）**
- [ ] **Step 2: 面板渲染测试（给 FilteredState fixture 渲染关键数字）**
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 对局状态store与信息面板"`

---

### Task 11: 行动交互层（重点 UX）

**Files:**
- Create: `packages/web/src/game/interactions.ts`（legalActions → 可点目标映射）
- Modify: `packages/web/src/board/BoardSvg.tsx`（高亮/点击）
- Create: `packages/web/src/game/ActionBar.tsx`（行动类型选择 → 参数收集 → submit）
- Test: `packages/web/src/game/interactions.test.ts`

**核心规则（违反会被 engine 判 illegal-action）：ActionBar 提交的必须是在 `legalActions` 中匹配到的条目本身，绝不新构造 Action 对象**——engine 对 scout cardIds 做有序逐元素比较（枚举按 i<j<k 产组合）、sell 只枚举"单块/全集"（设计 §3 规范化）。参数收集 = 逐步缩小 legalActions 子集，最后取唯一匹配项。

**Interfaces:**
- Produces:
  - `targetsFor(selectedCard, legalActions): { locations: Set<string>; links: Set<number>; industries: Map<string, IndustryType[]> }`——选中手牌后算出棋盘上可点目标
  - 交互流：点手牌 → BoardSvg 高亮可建槽/可铺边 → 点目标 → ActionBar 确认（sell 多块、双轨两条、develop 1-2 块、scout 3 弃牌的多选收集）→ submit_action
  - 非当前玩家：棋盘只读，显示"等待 X 行动"

- [ ] **Step 1: interactions 单测**（给定 legalActions fixture：location 卡 → 该地高亮；industry 卡 → network 内地点；network 行动 → 边高亮；scout → 需选 3 张）
- [ ] **Step 2: 组件接线（BoardSvg 高亮 props、ActionBar 确认提交）**
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 行动交互层（合法目标高亮与提交）"`

---

### Task 12: 大厅与房间流程 UI + 断线重连

**Files:**
- Create: `packages/web/src/lobby/Lobby.tsx`（创建/加入表单、房间号展示、座位列表、开始按钮）
- Modify: `packages/web/src/App.tsx`（路由：大厅 ↔ 对局，无路由库——条件渲染）
- Modify: `packages/web/src/game/store.ts`（token 存 localStorage、断线自动 resume）

- [ ] **Step 1: Lobby 组件测试（创建→显示房间号；加入→座位列表；满员开始按钮可用）**
- [ ] **Step 2: resume 流程测试（localStorage mock：刷新后自动 resume 回座位）**
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 大厅流程与断线重连"`

---

### Task 13: M2 收尾——真人手动验收 + README + CI 总核对

**Files:**
- Modify: `README.md`（M2 状态、dev 启动指南：`npm run dev -w @brass/server` + `npm run dev -w @brass/web`，或 build 后单端口）
- Modify: `packages/web/vitest.config.ts`（coverage 配置与 engine 一致风格）
- 声明：设计 §4 的"真人回合提醒按钮"推迟到 M5（M2 仅"等待 X 行动"只读提示）

- [ ] **Step 1: 手动验收脚本（报告里逐项打勾）**：两个浏览器窗口（或两机器局域网）建房 → 加入 → 开始 → 各行动类型至少一次 → 打完一局 → 终局画面 → 刷新重连 → 历史对局落库（sqlite 查表）
- [ ] **Step 2: README + CI 核对（三个新包都在 typecheck+test 聚合里）**
- [ ] **Step 3: Commit + PR**
