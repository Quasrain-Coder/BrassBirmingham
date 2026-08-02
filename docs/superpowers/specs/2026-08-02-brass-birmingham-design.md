# BrassBirmingham — 设计文档

v1.0，2026-08-02 定稿（brainstorming 阶段产出，经用户逐节确认）

> 本项目是桌游《Brass: Birmingham》规则的非官方、非商业数字实现，浏览器多人对局 + LLM AI 玩家 + 赛后复盘教练。不含任何原版美术与卡牌文字，棋盘为自绘简化 SVG。

## 1. 目标与范围

- 完整规则：运河时代 + 铁路时代，2–4 人官方规则（含 2 人变体的板块移除）
- 浏览器联机（局域网/公网自托管），权威服务器 + 房间短码
- AI 座位由 LLM（Claude API）驱动，行动空间受引擎硬约束
- 赛后生成完整复盘报告：关键决策点分析、具体替代方案及原因
- SQLite 持久化：对局、action log、复盘报告；支持断线重连与历史对局
- 非目标（YAGNI）：账号体系、聊天、移动端原生应用、MCTS（仅预留接口）、原版美术还原

## 2. 总体架构

TypeScript monorepo（pnpm workspaces）：

```
packages/
  engine/    # 纯 TS、零依赖：完整规则 + 合法行动枚举 + 状态机，确定性、可单测
  server/    # Node + WebSocket 权威服务器，房间管理，SQLite (Drizzle) 落库
  web/       # React + Vite + SVG 棋盘客户端
  llm/       # LLM 玩家（虚拟座位）+ 复盘教练，调 Claude API
```

核心边界：**规则引擎是纯函数库**，被 server（权威裁决）、web（本地预检合法行动、UI 高亮）、llm（行动空间枚举）、复盘（log 重放）四方复用同一份代码。

## 3. 规则引擎（engine）

### 状态（GameState，纯数据，可 JSON 序列化）

- `board`：静态图——17 个城市/地点（含 4 个外部市场）、连接边（运河边 / 铁路边分开标注）；动态部分为城市产业槽位占用、已建连接、外部市场需求轨
- `players[]`：手牌、个人产业板块堆叠（每种产业按等级叠放，建造即弹栈）、现金、收入轨位置、收入等级、本回合已花费（决定顺位）、VP
- `resources`：煤需求轨、铁需求轨、啤酒供应（酿酒厂翻面产出 + 商人啤酒）；价格随存量滑动
- `era`：`canal | rail`，时代切换时清算连接分、移除低级产业、重洗牌
- `turn`：当前玩家、本回合已执行行动数（1–2 动）、阶段标记
- `rng seed`：所有随机性走注入的种子随机数，保证 action log 重放逐字节一致

### 行动（Action，discriminated union）

`build / network / develop / sell / loan / scout / pass`，每个 action 携带完整参数（打哪张牌、建在哪个槽、卖货链路、啤酒来源等）。

两个核心函数：

```ts
enumerateActions(state, player): Action[]   // 合法行动全集——AI、前端提示、复盘共用
applyAction(state, action): GameState       // 纯函数；非法行动抛结构化错误
```

`applyAction` 收口全部子规则：build 连通性校验、煤铁最短路径消耗结算、sell 啤酒来源合法性、翻面触发收入轨前进等。

### 规则数值配置化

产业数值表（成本/收益/翻面条件）、牌组构成、各人数起始设置放在 `engine/data/` 的 TS 常量文件，与规则逻辑分离，便于校对。

## 4. 服务器、房间与同步（server）

### 房间生命周期

`创建（人数、AI 座位数、种子可选） → 大厅（房主调整 AI 座位、开始） → 对局中 → 结束 → 存档`。房间号 6 位短码；无账号体系，昵称 + op token（localStorage），断线凭 token 重连回原座位。

### 同步协议（WebSocket，JSON）

权威服务器模型，客户端永不本地推进状态：

- 下行：`state_snapshot`（按座位视角过滤后的全量快照 + 递增 seq；Brass 状态小，全量优于增量 diff）、`action_applied`、`error`
- 上行：`submit_action`、`ping`
- **视角过滤**：手牌为私有信息，服务器按座位下发——只发自己的手牌，其他人只有牌数
- 断线重连：重连后拉最新快照，seq 对齐
- 真人回合无强制超时，v1 仅"提醒"按钮

### 持久化（SQLite via Drizzle）

- `games`：id、房间配置、初始种子、最终状态、时间戳
- `actions`：game_id、seq、player、action JSON（对局 = 初始状态 + action log，重放/断线重连/复盘共用此数据）
- `reviews`：game_id、player、报告 markdown、模型、token 用量

### 错误处理

引擎非法行动错误带结构化 reason，透传前端显示；LLM 座位连续非法行动时降级（见 §5），对局永不卡死。

## 5. LLM 玩家（llm）

原则：**LLM 只做"选择"，不做"计算"**；规则结算永远在引擎，行动空间被 `enumerateActions` 硬约束。

决策流程（轮到 AI 座位）：

1. 引擎枚举合法行动全集；**启发式预筛**（板块等级、连通性、资源可得性、收入轨收益）剪到 Top ~20 候选
2. 组装 prompt：结构化文字局势摘要（非 JSON dump：资金/收入/手牌、各人产业与网络、市场价格与存量、时代与轮次）+ 候选行动列表（每个附一句话解释）
3. Claude API（Sonnet 级），tool use / structured output 强制返回候选编号 + 一句理由；理由显示在游戏日志中
4. 引擎校验合法性；非法 → 带原因重试一次 → 再非法降级为预筛 Top 1 并日志标注

难度分层：简单（Top 8 + 高速模型）/ 普通（Top 20）/ 困难（Top 40 + 两轮前瞻摘要）。

成本与延迟：prompt 前缀模板化吃缓存；单次决策目标 < 10s / < $0.01。服务器 key 走环境变量，`.env` gitignored，提供 `.env.example`。

接口预留：`PlayerAgent` 接口（`chooseAction(state, legalMoves) → Action`），实现含 LLMAgent、RandomAgent（测试）、未来的 MCTSAgent。

## 6. 复盘教练（llm + engine）

输入为落库的 action log；输出为按玩家生成的 markdown 报告（只分析本人操作）。

生成流程（赛后点击触发，异步，完成推送）：

1. **重放标注（确定性）**：重放 log，在每个决策点重新 `enumerateActions`，用启发式评估函数给实际选择与候选 Top N 打分；产出每步分差、分差最大 Top 10 决策点、时代切换站位统计
2. **LLM 分析（Opus 级）**：Top 决策点分批送入，每点附局面摘要、实际选择、候选替代、启发式分差；要求：
   - 判断启发式分差是否"真错误"（识别启发式看不出的长线布局并辩护）
   - 给出具体替代操作与原因链（引用具体回合与板块，禁止空泛建议）
3. **报告结构**：总评（打法风格识别）→ 3–5 个关键转折点逐手分析 → 时代切换站位评估 → 下局 1–3 条可执行建议 → 每手启发式分差曲线图

设计要点：启发式先行找"最值得讲的 10 手"，LLM token 花在刀刃上；分差曲线是客观锚点。报告按需生成（不自动烧 token），每局每人一份，用量入 `reviews` 表。

## 7. 前端（web）

- 自绘简化 SVG 地图：城市为节点、连接为边、产业槽位为城市旁格子；功能性优先
- 交互围绕 `enumerateActions`：本地预检，可打的牌高亮、可建槽位亮边，点击构造 action 提交——非法操作在 UI 层不可能出现，服务器校验兜底
- 面板：市场（煤/铁/啤酒）、收入轨与 VP、行动日志（含 AI 理由）、回合顺位条
- 复盘报告页：markdown 渲染 + 分差曲线 + 跳转到对应回合的只读棋盘回放

## 8. 测试策略

- 引擎（密度最高）：规则数据表驱动单测；种子固定重放一致性测试；**RandomAgent 随机对局 fuzz**（数千局，断言无非预期异常、必然终止、分数可解释）
- 服务器：协议层集成测试（建房/加入/行动/断线重连）
- LLM：client 接口可注入，测试用录制 fixture，CI 不烧 token
- CI（GitHub Actions）：lint + typecheck + 全部测试；**新增模块必须同步更新 CI test/coverage 步骤**

## 9. 里程碑

1. **M1 引擎**：完整规则 + enumerateActions + RandomAgent fuzz 通过（最大工作块，纯后端）
2. **M2 可玩**：服务器 + 房间 + 最小可用前端，真人浏览器对局
3. **M3 AI 入局**：LLM 座位 + 降级链 + 难度档
4. **M4 复盘**：评分标注器 + 报告生成 + 报告页与回放
5. **M5 打磨**：断线重连完善、历史对局列表、Docker 一键部署、README 完整化

每个里程碑结束均为可运行、可演示状态。

## 10. Git 工作流（沿用 Fortuna 约定）

- 禁止直接向 `main` 提交/推送，无任何例外；改动必须 分支 → push → PR → 合并
- 分支命名：`feat/...`、`fix/...`、`docs/...`、`refactor/...`
- PR 合并前 CI 必须通过；设计层面变更同步更新本文档
- Claude 参与的提交带 `Co-Authored-By` 尾注
