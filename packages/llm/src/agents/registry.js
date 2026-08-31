import heuristicV1 from './heuristic-v1.js';
import heuristicV2 from './heuristic-v2.js';
const BUILTIN_PLUGINS = {
    'heuristic-v1': heuristicV1,
    'heuristic-v2': heuristicV2,
};
/** 大厅缺省 AI（行为与插件化之前一致）。 */
export const DEFAULT_SPEC = 'builtin:heuristic-v1';
/** 已登记的内置插件清单（大厅可选列表/跑分用）。 */
export function listAgentPlugins() {
    return Object.values(BUILTIN_PLUGINS).map((p) => p.meta);
}
/** 解析 spec → 插件（exec: 尚未实现，明确报错而非静默降级）。 */
export function resolveAgentPlugin(spec) {
    const [kind, name] = spec.split(':', 2);
    if (kind === 'builtin' && name !== undefined && name in BUILTIN_PLUGINS) {
        return BUILTIN_PLUGINS[name];
    }
    if (kind === 'exec') {
        throw new Error(`exec: 外部进程插件尚未实现（${spec}）`);
    }
    throw new Error(`未知 AI 插件 spec: ${spec}（可用：${Object.keys(BUILTIN_PLUGINS).map((n) => `builtin:${n}`).join(', ')}）`);
}
/**
 * spec + 上下文 → DecidingAgent（server 统一入口）。
 * 插件只返回 Action；reason/degraded/usage 在此包装成 Decision。
 */
export function createAgent(spec, ctx) {
    const plugin = resolveAgentPlugin(spec);
    const instance = plugin.create(ctx);
    return {
        decide: async (state, player, legal) => {
            const action = await instance.decide({ state, seat: player, legal });
            return {
                action,
                reason: instance.explain?.() ?? plugin.meta.name,
                degraded: true, // 非 LLM 直连路径（与 HeuristicAgent 旧语义一致）
                usage: { input: 0, output: 0 },
            };
        },
    };
}
/** server aiAgentFactory 适配：(seat, difficulty) → DecidingAgent。 */
export function agentFactoryFromSpec(spec) {
    return (seat, difficulty) => createAgent(spec, { seat, difficulty });
}
