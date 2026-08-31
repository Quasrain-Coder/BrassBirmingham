/**
 * heuristic-v1：启发式 AI 第一版（移植自 brass-assistant 重构前版本，PR #48 引入）。
 *
 * 单文件插件示例/范本：重逻辑在 ../heuristic.ts（评分库），本文件只做
 * 契约适配——新贡献者参考的"最小编辑单元"就是这个壳 + registry 一行。
 */
import { HeuristicAgent } from '../heuristic.js';
const plugin = {
    meta: {
        name: 'heuristic-v1',
        version: '1.0.0',
        description: '启发式评分 AI v1（brass-assistant 2026-08 初版移植 + 2-ply 前瞻）',
        author: 'brass-birmingham',
    },
    create: () => {
        const inner = new HeuristicAgent();
        return {
            decide: async ({ state, seat, legal }) => (await inner.decide(state, seat, legal)).action,
        };
    },
};
export default plugin;
