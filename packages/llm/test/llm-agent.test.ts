import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { enumerateActions, newGame } from '@brass/engine';
import { SYSTEM_PROMPT, describeAction } from '../src/summarize.js';
import { prescreen } from '../src/heuristic.js';
import { DIFFICULTY, LLMAgent } from '../src/llm-agent.js';
import { FixtureClient, makeResponse } from './fixtures.js';

const SEED = 42;

// 缺省模式是 argmax（不调 LLM）；本文件测 LLM 决策链，显式开 llm 模式。
beforeAll(() => {
  process.env['BRASS_AI_LLM_MODE'] = 'llm';
});
afterAll(() => {
  delete process.env['BRASS_AI_LLM_MODE'];
});

function opening() {
  const state = newGame(4, SEED);
  return { state, legal: enumerateActions(state, 0) };
}

describe('BRASS_AI_LLM_MODE', () => {
  it('缺省 argmax：零 LLM 调用，选 prescreen Top-1', async () => {
    delete process.env['BRASS_AI_LLM_MODE'];
    const { state, legal } = opening();
    const client = new FixtureClient(makeResponse(0));
    const d = await new LLMAgent(client, 'normal').decide(state, 0, legal);
    expect(client.requests).toHaveLength(0);
    expect(d.degraded).toBe(true);
    expect(d.reason).toContain('argmax');
    expect(prescreen(state, 0, legal, DIFFICULTY.normal.topK)[0]).toBe(d.action);
    process.env['BRASS_AI_LLM_MODE'] = 'llm';
  });
});

describe('DIFFICULTY', () => {
  it('easy 用 haiku + topK 8，normal/hard 用 sonnet，timeout 均 8000', () => {
    expect(DIFFICULTY.easy.topK).toBe(8);
    expect(DIFFICULTY.easy.model).toBe('claude-haiku-4-5');
    expect(DIFFICULTY.normal.topK).toBe(20);
    expect(DIFFICULTY.normal.model).toBe('claude-sonnet-4-5');
    expect(DIFFICULTY.hard.topK).toBe(40);
    expect(DIFFICULTY.hard.model).toBe('claude-sonnet-4-5');
    for (const cfg of Object.values(DIFFICULTY)) {
      expect(cfg.timeoutMs).toBe(8000);
      expect(cfg.maxTokens).toBe(512);
    }
  });
});

describe('LLMAgent 正常路径', () => {
  it('按 choiceIndex 选候选，reason 透传，usage 记录，degraded=false', async () => {
    const { state, legal } = opening();
    const client = new FixtureClient(
      makeResponse(2, '煤炭开局抢占市场', { input: 123, output: 45 }),
    );
    const agent = new LLMAgent(client, 'normal');
    const d = await agent.decide(state, 0, legal);

    const candidates = prescreen(state, 0, legal, DIFFICULTY.normal.topK);
    expect(d.action).toEqual(candidates[2]);
    expect(d.reason).toBe('煤炭开局抢占市场');
    expect(d.degraded).toBe(false);
    expect(d.usage).toEqual({ input: 123, output: 45 });
  });

  it('请求内容：system 静态、model/candidates/maxTokens/timeoutMs 按难度', async () => {
    const { state, legal } = opening();
    const client = new FixtureClient(makeResponse(0));
    const agent = new LLMAgent(client, 'easy');
    await agent.decide(state, 0, legal);

    expect(client.requests).toHaveLength(1);
    const req = client.requests[0]!;
    expect(req.system).toBe(SYSTEM_PROMPT);
    expect(req.model).toBe(DIFFICULTY.easy.model);
    expect(req.maxTokens).toBe(DIFFICULTY.easy.maxTokens);
    expect(req.timeoutMs).toBe(DIFFICULTY.easy.timeoutMs);
    const candidates = prescreen(state, 0, legal, DIFFICULTY.easy.topK);
    expect(req.candidates).toBe(candidates.length);
    // user 含候选描述（编号与 prescreen 顺序一致）
    expect(req.user).toContain(
      `0. ${describeAction(state, 0, candidates[0]!)}`,
    );
  });

  it('所选 action 恒在 legal 集内', async () => {
    const { state, legal } = opening();
    const client = new FixtureClient(makeResponse(1));
    const d = await new LLMAgent(client, 'normal').decide(state, 0, legal);
    expect(legal).toContainEqual(d.action);
  });
});

describe('LLMAgent 校验与重试', () => {
  it('choiceIndex 越界 → 带原因重试一次，重试 prompt 包含错误原因', async () => {
    const { state, legal } = opening();
    const client = new FixtureClient(
      makeResponse(999, '乱选', { input: 10, output: 5 }),
      makeResponse(1, '改正后的选择', { input: 20, output: 6 }),
    );
    const agent = new LLMAgent(client, 'normal');
    const d = await agent.decide(state, 0, legal);

    expect(client.requests).toHaveLength(2);
    const retryUser = client.requests[1]!.user;
    expect(retryUser).toContain('上次回复无效');
    expect(retryUser).toContain('999'); // 错误原因含越界的编号
    const candidates = prescreen(state, 0, legal, DIFFICULTY.normal.topK);
    expect(d.action).toEqual(candidates[1]);
    expect(d.reason).toBe('改正后的选择');
    expect(d.degraded).toBe(false);
    // 两次调用的 usage 累计
    expect(d.usage).toEqual({ input: 30, output: 11 });
  });

  it('choiceIndex 为 -1（含无 tool_use 哨兵）→ 重试，原因指明须调用 choose 工具', async () => {
    const { state, legal } = opening();
    const client = new FixtureClient(makeResponse(-1), makeResponse(0));
    const d = await new LLMAgent(client, 'normal').decide(state, 0, legal);
    expect(client.requests).toHaveLength(2);
    const retryUser = client.requests[1]!.user;
    expect(retryUser).toContain('上次回复无效');
    expect(retryUser).toContain('未返回结构化选择');
    expect(retryUser).toContain('choose 工具');
    expect(d.degraded).toBe(false);
  });

  it('二次仍越界 → 降级 HeuristicAgent Top-1，degraded=true，原因含错误说明', async () => {
    const { state, legal } = opening();
    const client = new FixtureClient(
      makeResponse(999, 'a', { input: 10, output: 5 }),
      makeResponse(998, 'b', { input: 20, output: 6 }),
    );
    const agent = new LLMAgent(client, 'normal');
    const d = await agent.decide(state, 0, legal);

    expect(client.requests).toHaveLength(2);
    expect(d.degraded).toBe(true);
    expect(legal).toContainEqual(d.action);
    // 降级走启发式 Top-1
    const expected = prescreen(state, 0, legal, 1)[0]!;
    expect(d.action).toEqual(expected);
    expect(d.reason).toContain('降级');
    // 已消耗的 token 仍记录
    expect(d.usage).toEqual({ input: 30, output: 11 });
  });
});

describe('LLMAgent API 异常降级', () => {
  it('首次调用抛错 → 降级，无重试', async () => {
    const { state, legal } = opening();
    const client = new FixtureClient(new Error('network timeout'));
    const d = await new LLMAgent(client, 'normal').decide(state, 0, legal);

    expect(client.requests).toHaveLength(1);
    expect(d.degraded).toBe(true);
    const expected = prescreen(state, 0, legal, 1)[0]!;
    expect(d.action).toEqual(expected);
    expect(d.reason).toContain('降级');
    expect(d.reason).toContain('network timeout');
  });

  it('重试调用抛错 → 降级', async () => {
    const { state, legal } = opening();
    const client = new FixtureClient(
      makeResponse(999, 'a', { input: 10, output: 5 }),
      new Error('429 rate limit'),
    );
    const d = await new LLMAgent(client, 'normal').decide(state, 0, legal);

    expect(client.requests).toHaveLength(2);
    expect(d.degraded).toBe(true);
    expect(d.reason).toContain('降级');
    expect(d.usage.input).toBe(10);
  });
});

describe('LLMAgent hard 前瞻段', () => {
  it('hard 难度的 user prompt 附时代进度与剩余轮数', async () => {
    const { state, legal } = opening();
    const client = new FixtureClient(makeResponse(0));
    await new LLMAgent(client, 'hard').decide(state, 0, legal);
    const user = client.requests[0]!.user;
    expect(user).toContain('前瞻');
    expect(user).toContain('剩余轮数');
    expect(user).toContain('运河时代');
  });

  it('normal 难度也含前瞻段（2026-09-05 起对 normal 开放：LLM 需感知剩余轮数）', async () => {
    const { state, legal } = opening();
    const client = new FixtureClient(makeResponse(0));
    await new LLMAgent(client, 'normal').decide(state, 0, legal);
    expect(client.requests[0]!.user).toContain('前瞻');
    expect(client.requests[0]!.user).toContain('行动位');
  });
});

describe('LLMAgent 边界', () => {
  it('legal 为空时抛错（调用方契约：必有合法行动）', async () => {
    const { state } = opening();
    const client = new FixtureClient();
    await expect(
      new LLMAgent(client, 'normal').decide(state, 0, []),
    ).rejects.toThrow();
    expect(client.requests).toHaveLength(0);
  });
});
