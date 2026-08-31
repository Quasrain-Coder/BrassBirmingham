/**
 * 插件注册表测试：契约形状、spec 解析、createAgent 决策合法性。
 */
import { describe, expect, it } from 'vitest';
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import {
  DEFAULT_SPEC,
  agentFactoryFromSpec,
  createAgent,
  listAgentPlugins,
  resolveAgentPlugin,
} from '../src/agents/registry.js';

describe('agent plugin registry', () => {
  it('登记清单含两个日期版本，元数据齐全', () => {
    const metas = listAgentPlugins();
    const names = metas.map((m) => m.name);
    expect(names).toContain('heuristic-v20260826');
    expect(names).toContain('heuristic-v20260829');
    for (const m of metas) {
      expect(m.version).toBeTruthy();
      expect(m.description).toBeTruthy();
    }
  });

  it('spec 解析：builtin 命中、未知报错、exec 明确未实现', () => {
    expect(resolveAgentPlugin('builtin:heuristic-v20260826').meta.name).toBe('heuristic-v20260826');
    expect(() => resolveAgentPlugin('builtin:nope')).toThrow(/未知 AI 插件/);
    expect(() => resolveAgentPlugin('exec:agents/foo.py')).toThrow(/尚未实现/);
    expect(DEFAULT_SPEC).toBe('builtin:heuristic-v20260829');
  });

  it('createAgent 的 decide 返回 legal 集内行动（两版本相同契约）', async () => {
    let state = newGame(4, 42);
    const agentV26 = createAgent('builtin:heuristic-v20260826', { seat: 0 });
    const agentV29 = createAgent('builtin:heuristic-v20260829', { seat: 0 });
    // 打 3 步（多步后状态才非平凡），逐步校验行动合法且 reason 为插件名
    for (let step = 0; step < 3; step++) {
      const seat = state.turnOrder[state.currentPlayerIdx]!;
      const legal = enumerateActions(state, seat);
      const agent = step % 2 === 0 ? agentV26 : agentV29;
      const d = await agent.decide(state, seat, legal);
      expect(legal).toContainEqual(d.action);
      expect(d.reason).toMatch(/heuristic-v2026082[69]/);
      expect(d.usage).toEqual({ input: 0, output: 0 });
      state = applyAction(state, d.action);
    }
  });

  it('agentFactoryFromSpec 形状与 server aiAgentFactory 一致', () => {
    const factory = agentFactoryFromSpec('builtin:heuristic-v20260826');
    const agent = factory(2, 'easy');
    expect(typeof agent.decide).toBe('function');
  });
});
