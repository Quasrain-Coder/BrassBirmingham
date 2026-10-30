import { describe, expect, it } from 'vitest';
import { enumerateActions, newGame } from '@brass/engine';
import type Anthropic from '@anthropic-ai/sdk';
import {
  AGENTBGA_TOOLS,
  legalActions,
  projectObservation,
  resolveActionId,
} from '../src/agents/agentbga-adapter.js';
import { AgentBGAClient, AgentBGAClientError, type AgentBGAClientRequest } from '../src/agents/agentbga-client.js';
import { createAgentBGAPlugin, type AgentBGAClientLike } from '../src/agents/agentbga-llm.js';
import { resolveAgentPlugin } from '../src/agents/registry.js';
import { createOpenAITransport } from '../src/agents/agentbga-openai.js';

function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock {
  return { id, type: 'tool_use', name, input, caller: { type: 'direct' } };
}

describe('AgentBGA adapter', () => {
  it('只暴露当前座位手牌与公开市场，ID 可稳定映射回原动作', () => {
    const state = newGame(4, 42);
    const seat = state.turnOrder[0]!;
    const observation = projectObservation(state, seat);
    expect(observation.players[seat]!.hand).toHaveLength(8);
    for (const player of observation.players) {
      const hand = player.hand as unknown[];
      const count = player.hand_count as number;
      if (player.seat !== seat) expect(hand).toHaveLength(0);
      expect(count).toBe(8);
    }
    expect(JSON.stringify(observation)).not.toContain('rngState');
    expect(observation.markets.coal.occupied.filter(Boolean)).toHaveLength(state.coalMarket);
    expect(observation.markets.iron.occupied.filter(Boolean)).toHaveLength(state.ironMarket);

    const legal = legalActions(state, seat, enumerateActions(state, seat));
    expect(new Set(legal.map((entry) => entry.id)).size).toBe(legal.length);
    expect(resolveActionId(legal[0]!.id, legal)).toBe(legal[0]!.action);
    expect(resolveActionId('not-a-legal-id', legal)).toBeUndefined();
    expect(resolveAgentPlugin('builtin:agentbga-llm').meta.name).toBe('agentbga-llm');
  });
});

describe('AgentBGA tool loop', () => {
  it('observe → legal_actions → submit_action 完整闭环并累计用量', async () => {
    const state = newGame(4, 42);
    const seat = state.turnOrder[0]!;
    const legal = legalActions(state, seat, enumerateActions(state, seat));
    const calls: string[] = [];
    const client = new AgentBGAClient({
      maxRounds: 3,
      transport: async () => {
        const name = calls.length === 0 ? 'observe' : calls.length === 1 ? 'legal_actions' : 'submit_action';
        return {
          content: [toolUse(name, name, name === 'submit_action' ? { action_id: legal[0]!.id } : {})],
          usage: { input_tokens: 4, output_tokens: 2 },
          reasoning: `思路 ${calls.length}\n保留换行`,
        };
      },
    });
    const result = await client.decide({
      system: 'seat 0',
      user: 'version 0',
      tools: AGENTBGA_TOOLS,
      invoke: async (name) => {
        calls.push(name);
        if (name === 'submit_action') return { ok: true, actionId: legal[0]!.id };
        return { ok: true };
      },
    });
    expect(result.actionId).toBe(legal[0]!.id);
    expect(calls).toEqual(['observe', 'legal_actions', 'submit_action']);
    expect(result.usage).toEqual({ input: 12, output: 6 });
    expect(result.reasoning?.rounds).toHaveLength(3);
    expect(result.reasoning?.rounds.map((round) => round.reasoning)).toEqual([
      '思路 0\n保留换行', '思路 1\n保留换行', '思路 2\n保留换行',
    ]);
  });

  it('超过工具轮数限制时抛出带用量的错误', async () => {
    const client = new AgentBGAClient({
      maxRounds: 2,
      transport: async () => ({ content: [], usage: { input_tokens: 3, output_tokens: 0 } }),
    });
    await expect(client.decide({
      system: 'seat 0', user: 'version 0', tools: AGENTBGA_TOOLS, invoke: async () => ({}),
    })).rejects.toMatchObject({ usage: { input: 6, output: 0 } });
  });

  it('插件成功提交时不降级，系统提示只有座次、游戏和工具', async () => {
    const state = newGame(4, 42);
    const seat = state.turnOrder[0]!;
    const legal = enumerateActions(state, seat);
    const ids = legalActions(state, seat, legal);
    let captured: AgentBGAClientRequest | undefined;
    const client: AgentBGAClientLike = {
      decide: async (req) => {
        captured = req;
        return { actionId: ids[0]!.id, usage: { input: 3, output: 2 } };
      },
    };
    const plugin = createAgentBGAPlugin({
      client,
      fallback: { decide: () => { throw new Error('fallback should not run'); } },
    });
    const agent = plugin.create({ seat });
    const action = await agent.decide({ state, seat, legal });
    expect(action).toBe(ids[0]!.action);
    expect(agent.decisionMeta!()).toEqual({ reason: `agentbga:${ids[0]!.id}`, degraded: false, usage: { input: 3, output: 2 } });
    expect(captured!.system).toContain(`seat ${seat}`);
    expect(captured!.system).toContain('brass_birmingham');
    expect(captured!.system).toContain('observe');
    expect(captured!.system).not.toContain('策略');
    expect(captured!.system).not.toContain('规则书');
    const history = await captured!.invoke('inspect_history', {}) as { total: number };
    expect(history.total).toBe(1);
  });

  it('非法 ID 或异常时降级到 1010 并保留原因和用量', async () => {
    const state = newGame(4, 42);
    const seat = state.turnOrder[0]!;
    const legal = enumerateActions(state, seat);
    const plugin = createAgentBGAPlugin({
      client: {
        decide: async () => ({ actionId: 'illegal-id', usage: { input: 4, output: 1 } }),
      },
      fallback: {
        decide: async () => ({ action: legal[0]!, reason: 'fallback', degraded: true, usage: { input: 0, output: 0 } }),
      },
    });
    const agent = plugin.create({ seat });
    const action = await agent.decide({ state, seat, legal });
    expect(action).toBe(legal[0]);
    expect(agent.decisionMeta!().degraded).toBe(true);
    expect(agent.decisionMeta!().usage).toEqual({ input: 4, output: 1 });
    expect(agent.decisionMeta!().reason).toContain('fallback');
  });

  it('禁用降级时直接抛出模型错误，不调用兜底', async () => {
    const previous = process.env['BRASS_AI_ALLOW_FALLBACK'];
    process.env['BRASS_AI_ALLOW_FALLBACK'] = '0';
    try {
      const state = newGame(4, 42);
      const seat = state.turnOrder[0]!;
      const legal = enumerateActions(state, seat);
      const plugin = createAgentBGAPlugin({
        client: { decide: async () => { throw new Error('model failed'); } },
        fallback: { decide: () => { throw new Error('fallback should not run'); } },
      });
      const agent = plugin.create({ seat });
      await expect(agent.decide({ state, seat, legal })).rejects.toThrow('model failed');
    } finally {
      if (previous === undefined) delete process.env['BRASS_AI_ALLOW_FALLBACK'];
      else process.env['BRASS_AI_ALLOW_FALLBACK'] = previous;
    }
  });

  it('OpenAI transport 跳过空 assistant、保留工具调用且默认无超时', async () => {
    const originalFetch = globalThis.fetch;
    let body = '';
    let signal: RequestInit['signal'];
    globalThis.fetch = async (_url, init) => {
      body = String(init?.body ?? '');
      signal = init?.signal;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: '完整推理\n第二行', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submit_action', arguments: '{"action_id":"a0"}' } }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }), { status: 200 });
    };
    try {
      const result = await createOpenAITransport({ apiKey: 'x', baseURL: 'https://example.test' })({
        model: 'm', maxTokens: 10, system: 's', messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: [] }], tools: AGENTBGA_TOOLS,
      });
      expect(result.content[0]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'submit_action' });
      expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
      expect(result.reasoning).toBe('完整推理\n第二行');
      expect(JSON.parse(body).messages).toHaveLength(2);
      expect(signal).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('网络超时时重试一次，不提前降级', async () => {
    let attempts = 0;
    const client = new AgentBGAClient({
      maxRounds: 1,
      transport: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        return {
          content: [toolUse('c1', 'submit_action', { action_id: 'a0' })],
          usage: { input_tokens: 5, output_tokens: 2 },
        };
      },
    });
    const result = await client.decide({
      system: 's', user: 'u', tools: AGENTBGA_TOOLS,
      invoke: async () => ({ ok: true, actionId: 'a0' }),
    });
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ actionId: 'a0', usage: { input: 5, output: 2 } });
  });

  it('429 限流时退避重试', async () => {
    let attempts = 0;
    const client = new AgentBGAClient({
      maxRounds: 1,
      transport: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('429 {"error":{"message":"rate limit"}}');
        return {
          content: [toolUse('c1', 'submit_action', { action_id: 'a0' })],
          usage: { input_tokens: 5, output_tokens: 2 },
        };
      },
    });
    const result = await client.decide({
      system: 's', user: 'u', tools: AGENTBGA_TOOLS,
      invoke: async () => ({ ok: true, actionId: 'a0' }),
    });
    expect(attempts).toBe(2);
    expect(result.actionId).toBe('a0');
  });

  it('客户端错误类型可被插件识别', () => {
    const error = new AgentBGAClientError('x', { input: 1, output: 0 });
    expect(error).toBeInstanceOf(Error);
    expect(error.usage).toEqual({ input: 1, output: 0 });
  });
});
