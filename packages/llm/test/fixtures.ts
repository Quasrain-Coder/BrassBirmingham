/**
 * 测试用 fixture ClaudeClient——录制全部请求、按脚本回放响应，不烧 token。
 *
 * - script 队列：依次消费；元素可为 DecideResponse（直接返回）、Error（抛出，
 *   模拟 API 异常）、或函数（按请求动态生成响应）。
 * - 队列耗尽后返回 defaultResponse（可在构造后改写）。
 * - requests 记录每次调用的完整 DecideRequest，供断言重试 prompt、model、
 *   candidates 数等。
 */
import type {
  ClaudeClient,
  DecideRequest,
  DecideResponse,
} from '../src/client.js';

export type FixtureStep =
  | DecideResponse
  | Error
  | ((req: DecideRequest) => DecideResponse);

export function makeResponse(
  choiceIndex: number,
  reason = 'fixture reason',
  usage: { input: number; output: number } = { input: 10, output: 5 },
): DecideResponse {
  return { choiceIndex, reason, usage };
}

export class FixtureClient implements ClaudeClient {
  readonly requests: DecideRequest[] = [];
  defaultResponse: DecideResponse = makeResponse(0);
  private readonly script: FixtureStep[];

  constructor(...script: FixtureStep[]) {
    this.script = [...script];
  }

  decide(req: DecideRequest): Promise<DecideResponse> {
    this.requests.push(req);
    const step = this.script.shift();
    if (step === undefined) return Promise.resolve(this.defaultResponse);
    if (step instanceof Error) return Promise.reject(step);
    if (typeof step === 'function') return Promise.resolve(step(req));
    return Promise.resolve(step);
  }
}
