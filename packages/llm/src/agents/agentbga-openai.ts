/** OpenAI Chat Completions 协议适配；端点完全由环境变量配置。 */
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentBGATransport } from './agentbga-client.js';

interface OpenAIResponse {
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string };
}

export function createOpenAITransport(opts: {
  apiKey: string | undefined;
  baseURL: string | undefined;
  timeoutMs?: number;
}): AgentBGATransport {
  const endpoint = `${(opts.baseURL ?? '').replace(/\/$/, '')}/v1/chat/completions`;
  const apiKey = opts.apiKey ?? process.env['BRASS_AI_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'];
  return async (req) => {
    if (!opts.baseURL) throw new Error('BRASS_AI_BASE_URL is required for OpenAI provider');
    if (!apiKey) throw new Error('API key is required for OpenAI provider');
    const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }];
    for (const message of req.messages) {
      if (message.role === 'user' && typeof message.content === 'string') {
        messages.push({ role: 'user', content: message.content });
        continue;
      }
      if (message.role === 'assistant') {
        const blocks = Array.isArray(message.content) ? message.content : [];
        const text = blocks.filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text).join('');
        const toolCalls = blocks.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
          .map((block) => ({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          }));
        if (!text && toolCalls.length === 0) continue;
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        continue;
      }
      if (message.role === 'user' && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type !== 'tool_result') continue;
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          });
        }
      }
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        messages,
        tools: req.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
          },
        })),
        tool_choice: 'auto',
      }),
      ...(opts.timeoutMs !== undefined && opts.timeoutMs > 0
        ? { signal: AbortSignal.timeout(opts.timeoutMs) }
        : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text}`);
    const data = JSON.parse(text) as OpenAIResponse;
    if (data.error) throw new Error(data.error.message ?? data.error.code ?? 'OpenAI provider error');
    const content: Anthropic.ContentBlock[] = [];
    const message = data.choices?.[0]?.message;
    if (message?.content) content.push({ type: 'text', text: message.content, citations: [] });
    for (const call of message?.tool_calls ?? []) {
      content.push({
        id: call.id,
        type: 'tool_use',
        name: call.function.name,
        input: JSON.parse(call.function.arguments || '{}'),
        caller: { type: 'direct' },
      });
    }
    return {
      content,
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      },
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      reasoning: message?.reasoning_content ?? message?.reasoning ?? '',
    };
  };
}
