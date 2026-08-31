/**
 * 生产入口：PORT（默认 8420）、DB_PATH（默认 ./brass.db）、WEB_DIST（存在则同端口托管）。
 * dev 不设 WEB_DIST——vite dev server 起静态，proxy 转发 /ws 到本进程。
 *
 * AI 座位：ANTHROPIC_API_KEY 存在时经 AnthropicClient 构造 LLMAgent（按房难度）；
 * 缺失 → aiAgentFactory 返回 HeuristicAgent（启动日志警告，对局可玩但无 LLM 决策）。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnthropicClient, LLMAgent, DEFAULT_SPEC, agentFactoryFromSpec, listAgentPlugins } from '@brass/llm';
import { createGameServer, type GameServerOptions } from './ws.js';

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? '8420');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT 非法: ${process.env['PORT']}`);
  }
  const options: GameServerOptions = {
    port,
    dbPath: process.env['DB_PATH'] ?? './brass.db',
    // AI 行动节奏:每步 AI 行动之间停 5s(与客户端聚光灯时长一致,启发式瞬算
    // 也能逐步看清 AI 过程);BRASS_AI_PACE_MS 可调,0 = 不减速。
    aiPaceMs: Number(process.env['BRASS_AI_PACE_MS'] ?? 5000),
    roundBreakMs: Number(process.env['BRASS_ROUND_BREAK_MS'] ?? 5000),
  };
  const webDist = process.env['WEB_DIST'];
  if (webDist !== undefined && webDist !== '' && existsSync(webDist)) {
    options.staticDir = resolve(webDist);
  }
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey !== undefined && anthropicKey !== '') {
    const client = new AnthropicClient({ apiKey: anthropicKey });
    options.aiAgentFactory = (_seat, difficulty) => new LLMAgent(client, difficulty);
  } else {
    // 插件式 AI（agents/ 单文件注册制）：BRASS_AI_SPEC 选择，缺省 heuristic-v20260826
    const spec = process.env['BRASS_AI_SPEC'] || DEFAULT_SPEC;
    console.warn(
      `[brass] ANTHROPIC_API_KEY 未设置：AI 座位用内置插件 ${spec}（可选：${listAgentPlugins().map((m) => `builtin:${m.name}`).join(', ')}），不产生 LLM 调用`,
    );
    options.aiAgentFactory = agentFactoryFromSpec(spec);
  }
  const server = await createGameServer(options);
  console.log(
    `[brass] listening on :${server.port} (db=${options.dbPath}` +
      `${options.staticDir !== undefined ? `, static=${options.staticDir}` : ''})`,
  );
  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// 纯入口文件：不设 import 守卫（vite-node/tsx 会把脚本路径从 argv 抹掉，守卫判不出来；
// 包内无任何模块 import 本文件）。
main().catch((e: unknown) => {
  console.error('[brass] 启动失败', e);
  process.exit(1);
});
