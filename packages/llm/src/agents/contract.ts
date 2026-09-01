/**
 * 插件式 AI 契约：一个 AI = 一个单文件插件（本目录一个 .ts 文件）。
 *
 * 设计目标（与用户构想对齐）：
 * - **最小编辑单元**：贡献一个新 AI 只需新增一个文件 + 在 registry.ts 登记一行。
 *   文件默认导出满足 AgentPlugin 的对象即可，不许改动 server/engine。
 * - **入参自包含**：DecideInput 携带决策所需的全部信息——完整 GameState、
 *   座位、已枚举的合法行动集、可选时间预算。插件只需返回 legal 中的一个行动。
 * - **语言无关的演进路径**：本契约是进程内 TS 版；后续 exec: 外部插件
 *   （py/rs 单文件，stdio NDJSON）传输同一结构（state 用 FilteredState 裁剪
 *   隐藏信息后序列化），本文件即协议文档。
 *
 * server 通过 createAgent(spec, ctx) 拿到 DecidingAgent（decision.ts），
 * 不知道也不关心背后是哪个插件。
 */
import type { Action, GameState, PlayerIndex } from '@brass/engine';

/** 插件元数据：大厅/日志/跑分展示用。 */
export interface AgentPluginMeta {
  /** 唯一 id（registry 登记键，如 'heuristic-v20260829'）。 */
  name: string;
  version: string;
  description: string;
  author?: string;
}

/** 一次决策的完整输入。 */
export interface DecideInput {
  /** 完整游戏状态（进程内插件可见上帝视角；自制 MCTS 请只用公开信息采样）。 */
  state: GameState;
  /** 本插件所控制的座位。 */
  seat: PlayerIndex;
  /** 当前座位的全部合法行动（engine enumerateActions 产出）。 */
  legal: Action[];
  /** 本步时间预算（毫秒），缺省由 server 决定。 */
  clockMs?: number;
}

/** 插件实例：一个座位一个实例，允许携带内部状态（如 MCTS 树缓存）。 */
export interface AgentInstance {
  /** 返回 legal 中的一个行动。 */
  decide(input: DecideInput): Action | Promise<Action>;
  /** 可选：一句话决策说明（写入 action_applied 的 reason，前端可见）。 */
  explain?(): string;
}

/** 插件创建上下文。 */
export interface AgentContext {
  seat: PlayerIndex;
  difficulty?: import('../llm-agent.js').Difficulty | undefined;
}

/** 插件本体：单文件默认导出此形状。 */
export interface AgentPlugin {
  meta: AgentPluginMeta;
  create(ctx: AgentContext): AgentInstance;
}
