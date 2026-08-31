/**
 * 插件注册表：spec 字符串 → AgentPlugin。
 *
 * 贡献新 AI 的两步（不许动其他文件）：
 * 1. 本目录新增单文件插件（默认导出 AgentPlugin，见 contract.ts 与 heuristic-v1.ts）；
 * 2. 在 BUILTIN_PLUGINS 加一行登记。
 *
 * spec 格式：`builtin:<name>`（本目录内置）；`exec:<path>`（外部进程插件，
 * stdio NDJSON，后续切片实现）。缺省 spec = DEFAULT_SPEC。
 */
import type { DecidingAgent } from '../decision.js';
import type { PlayerIndex } from '@brass/engine';
import type { AgentContext, AgentPlugin } from './contract.js';
/** 大厅缺省 AI（行为与插件化之前一致）。 */
export declare const DEFAULT_SPEC = "builtin:heuristic-v1";
/** 已登记的内置插件清单（大厅可选列表/跑分用）。 */
export declare function listAgentPlugins(): AgentPlugin['meta'][];
/** 解析 spec → 插件（exec: 尚未实现，明确报错而非静默降级）。 */
export declare function resolveAgentPlugin(spec: string): AgentPlugin;
/**
 * spec + 上下文 → DecidingAgent（server 统一入口）。
 * 插件只返回 Action；reason/degraded/usage 在此包装成 Decision。
 */
export declare function createAgent(spec: string, ctx: AgentContext): DecidingAgent;
/** server aiAgentFactory 适配：(seat, difficulty) → DecidingAgent。 */
export declare function agentFactoryFromSpec(spec: string): (seat: PlayerIndex, difficulty?: import('../llm-agent.js').Difficulty) => DecidingAgent;
