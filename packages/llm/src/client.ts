/**
 * ClaudeClient 抽象与 AnthropicClient 实现。
 *
 * - ClaudeClient：决策链对 LLM 的最小依赖——一次 decide 请求（system 静态、
 *   user 动态、candidates 候选数、model/maxTokens/timeoutMs）返回结构化选择
 *   （choiceIndex + reason + token usage）。测试用 fixture client 替换，不烧
 *   token（见 test/fixtures.ts）。
 * - AnthropicClient：@anthropic-ai/sdk 实现。**tool use 强制结构**——定义
 *   `choose` tool（choice_index 整数 + reason 字符串），tool_choice 强制调用，
 *   从 tool_use block 解析输入，杜绝自由文本 JSON 解析脆弱性。响应不含
 *   tool_use 时返回 choiceIndex=-1（由 LLMAgent 校验层走重试/降级，本层不判
 *   候选界——它不知道候选集）。
 * - model：以 req.model 为准（调用方按难度给）；req.model 为空串时回落环境
 *   变量 BRASS_AI_MODEL，再回落 claude-sonnet-4-5。
 * - timeout：用 SDK 的 per-request timeout 选项（req.timeoutMs，毫秒），超时
 *   抛 APIConnectionTimeoutError，由 LLMAgent 捕获降级。
 */
import Anthropic from '@anthropic-ai/sdk';

/** 一次决策请求。model 为空串时由实现方回落默认。 */
export interface DecideRequest {
  system: string;
  user: string;
  /** 候选行动数（choiceIndex 合法域 [0, candidates)，写入 tool schema 描述）。 */
  candidates: number;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

/** 结构化选择结果；choiceIndex 不保证在界内（校验在 LLMAgent）。 */
export interface DecideResponse {
  choiceIndex: number;
  reason: string;
  usage: { input: number; output: number };
}

export interface ClaudeClient {
  decide(req: DecideRequest): Promise<DecideResponse>;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';

/** choose tool 的输入结构（Anthropic tool_use input 为 unknown，窄化用）。 */
interface ChooseInput {
  choice_index?: unknown;
  reason?: unknown;
}

function parseChooseInput(input: unknown): { choiceIndex: number; reason: string } {
  const raw: ChooseInput = typeof input === 'object' && input !== null ? input : {};
  // 非整数（含小数，如 -0.5）视为无效：返回 -1 走 LLMAgent 重试通道，
  // 不做 Math.trunc 静默截断（-0.5 截断成 -0 会误中候选 0）。
  const idx =
    typeof raw.choice_index === 'number' && Number.isInteger(raw.choice_index)
      ? raw.choice_index
      : -1;
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  return { choiceIndex: idx, reason };
}

/** Anthropic Messages API 实现（tool use 强制 choose 结构）。 */
export class AnthropicClient implements ClaudeClient {
  private readonly anthropic: Anthropic;

  constructor(opts?: { apiKey?: string; baseURL?: string }) {
    // apiKey 缺省时 SDK 读 ANTHROPIC_API_KEY 环境变量；
    // maxRetries: 0——SDK 默认对 429/5xx 内部重试 2 次会侵蚀 8s 超时预算，
    // 失败直接抛给 LLMAgent 走降级（重试策略由决策层持有）。
    this.anthropic = new Anthropic({
      maxRetries: 0,
      ...(opts?.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts?.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    });
  }

  async decide(req: DecideRequest): Promise<DecideResponse> {
    const model = req.model || process.env['BRASS_AI_MODEL'] || DEFAULT_MODEL;
    const tool: Anthropic.Tool = {
      name: 'choose',
      description:
        `从候选行动中选择一个。choice_index 为候选编号，须在 0 到 ` +
        `${req.candidates - 1} 之间（含两端）；reason 为一句话中文理由。`,
      input_schema: {
        type: 'object',
        properties: {
          choice_index: {
            type: 'integer',
            description: `候选编号（0 到 ${req.candidates - 1}，含两端）`,
          },
          reason: { type: 'string', description: '一句话中文理由' },
        },
        required: ['choice_index', 'reason'],
      },
    };
    const msg = await this.anthropic.messages.create(
      {
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        tools: [tool],
        tool_choice: { type: 'tool', name: 'choose' },
      },
      { timeout: req.timeoutMs },
    );
    const block = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'choose',
    );
    const { choiceIndex, reason } = block
      ? parseChooseInput(block.input)
      : { choiceIndex: -1, reason: '' };
    return {
      choiceIndex,
      reason,
      usage: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
      },
    };
  }
}
