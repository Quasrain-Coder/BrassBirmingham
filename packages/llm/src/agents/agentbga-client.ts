/**
 * 与 AgentBGA minimal harness 同形态的多轮工具调用客户端。
 * 不预置规则书；模型通过 observe/legal_actions 获取事实并提交一个动作 ID。
 */
import Anthropic from '@anthropic-ai/sdk';
import { createOpenAITransport } from './agentbga-openai.js';
import type { AgentDecisionReasoning } from './contract.js';

export interface AgentBGAClientRequest {
  system: string;
  user: string;
  tools: Anthropic.Tool[];
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentBGAClientResponse {
  actionId: string;
  usage: { input: number; output: number };
  reasoning?: AgentDecisionReasoning;
}

interface TransportMessage {
  content: Anthropic.ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
  finishReason?: string | null;
  reasoning?: string;
}

interface TransportRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export type AgentBGATransport = (req: TransportRequest) => Promise<TransportMessage>;

export class AgentBGAClientError extends Error {
  constructor(message: string, readonly usage: { input: number; output: number }) {
    super(message);
    this.name = 'AgentBGAClientError';
  }
}

export class AgentBGAClient {
  private readonly anthropic: Anthropic;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly maxRounds: number;
  private readonly transport: AgentBGATransport | undefined;
  private readonly provider: 'anthropic' | 'openai';
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;

  constructor(opts?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    timeoutMs?: number;
    maxTokens?: number;
    maxRounds?: number;
    provider?: 'anthropic' | 'openai';
    transport?: AgentBGATransport;
  }) {
    const baseURL = opts?.baseURL ?? process.env['BRASS_AI_BASE_URL'];
    this.anthropic = new Anthropic({
      maxRetries: 0,
      ...(opts?.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(baseURL !== undefined ? { baseURL } : {}),
    });
    this.model = opts?.model ?? process.env['BRASS_AI_MODEL'] ?? 'claude-sonnet-4-5';
    // 0 = 不主动超时；模型仍在生成时持续等待。
    this.timeoutMs = opts?.timeoutMs ?? Number(process.env['BRASS_AI_TIMEOUT_MS'] ?? 0);
    this.maxTokens = opts?.maxTokens ?? Number(process.env['BRASS_AI_MAX_TOKENS'] ?? 2048);
    this.maxRounds = opts?.maxRounds ?? 8;
    this.transport = opts?.transport;
    this.provider = (opts?.provider ?? process.env['BRASS_AI_PROVIDER']) === 'openai' ? 'openai' : 'anthropic';
    this.apiKey = opts?.apiKey;
    this.baseURL = baseURL;
  }

  async decide(req: AgentBGAClientRequest): Promise<AgentBGAClientResponse> {
    const usage = { input: 0, output: 0 };
    const reasoning: AgentDecisionReasoning = { rounds: [] };
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.user }];
    const started = Date.now();
    const log = (event: string) => {
      if (process.env['BRASS_AI_DEBUG'] === '1') {
        console.log(`llm ${event} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
      }
    };
    log(`decision begin model=${this.model}`);
    try {
      for (let round = 0; round < this.maxRounds; round++) {
        let msg: TransportMessage | undefined;
        for (let attempt = 1; ; attempt++) {
          log(`request begin round=${round + 1} attempt=${attempt} messages=${messages.length} timeout_ms=${this.timeoutMs} max_tokens=${this.maxTokens}`);
          const heartbeat = setInterval(() => {
            log(`waiting round=${round + 1} attempt=${attempt}`);
          }, 30_000);
          try {
            msg = await this.call({ model: this.model, maxTokens: this.maxTokens, system: req.system, messages, tools: req.tools });
            break;
          } catch (error) {
            const name = error instanceof Error ? error.name : '';
            const message = error instanceof Error ? error.message : String(error);
            const retryable = ['AbortError', 'TimeoutError'].includes(name)
              || /^(?:408|409|429|5\d\d)\s|rate.?limit|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(message);
            const retryDelayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
            log(`request error round=${round + 1} attempt=${attempt} retry=${retryable} retry_in_ms=${retryable ? retryDelayMs : 0} error=${message}`);
            if (!retryable) throw error;
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          } finally {
            clearInterval(heartbeat);
          }
        }
        if (!msg) throw new Error('agentbga: empty transport response');
        usage.input += msg.usage.input_tokens;
        usage.output += msg.usage.output_tokens;
        const visibleText = msg.content.filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text).join('');
        const thinking = msg.reasoning ?? msg.content.flatMap((block) => {
          const candidate = block as unknown as { type: string; thinking?: unknown };
          return candidate.type === 'thinking' && typeof candidate.thinking === 'string' ? [candidate.thinking] : [];
        }).join('\n');
        reasoning.rounds.push({
          round: round + 1,
          reasoning: thinking,
          text: visibleText,
          toolCalls: msg.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use').map((block) => block.name),
        });
        log(`response round=${round + 1} input=${msg.usage.input_tokens} output=${msg.usage.output_tokens} finish=${msg.finishReason ?? 'n/a'} tools=${reasoning.rounds.at(-1)!.toolCalls.join(',') || 'none'} text_chars=${visibleText.length} reasoning_chars=${thinking.length}`);
        messages.push({ role: 'assistant', content: msg.content });
        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          const args = typeof block.input === 'object' && block.input !== null
            ? block.input as Record<string, unknown>
            : {};
          let result: unknown;
          log(`tool begin round=${round + 1} name=${block.name}`);
          try {
            result = await req.invoke(block.name, args);
          } catch (error) {
            result = { error: error instanceof Error ? error.message : String(error) };
          }
          log(`tool end round=${round + 1} name=${block.name}`);
          if (block.name === 'submit_action' && typeof result === 'object' && result !== null) {
            const submitted = result as { ok?: unknown; actionId?: unknown };
            if (submitted.ok === true && typeof submitted.actionId === 'string') {
              log(`submitted round=${round + 1} action=${submitted.actionId}`);
              return { actionId: submitted.actionId, usage, reasoning };
            }
          }
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            }],
          });
        }
      }
      throw new AgentBGAClientError(`agentbga: no valid submit_action after ${this.maxRounds} tool rounds`, usage);
    } catch (error) {
      log(`error=${error instanceof Error ? error.message : String(error)} input=${usage.input} output=${usage.output}`);
      if (error instanceof AgentBGAClientError) throw error;
      throw new AgentBGAClientError(error instanceof Error ? error.message : String(error), usage);
    }
  }

  private async call(req: TransportRequest): Promise<TransportMessage> {
    if (this.transport) return this.transport(req);
    if (this.provider === 'openai') {
      return createOpenAITransport({ apiKey: this.apiKey, baseURL: this.baseURL, timeoutMs: this.timeoutMs })(req);
    }
    return this.anthropic.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      tool_choice: { type: 'auto' },
    }, { timeout: this.timeoutMs > 0 ? this.timeoutMs : 2_147_483_647 });
  }
}
