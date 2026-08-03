/**
 * 生产入口：PORT（默认 8420）、DB_PATH（默认 ./brass.db）、WEB_DIST（存在则同端口托管）。
 * dev 不设 WEB_DIST——vite dev server 起静态，proxy 转发 /ws 到本进程。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGameServer, type GameServerOptions } from './ws.js';

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? '8420');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT 非法: ${process.env['PORT']}`);
  }
  const options: GameServerOptions = {
    port,
    dbPath: process.env['DB_PATH'] ?? './brass.db',
  };
  const webDist = process.env['WEB_DIST'];
  if (webDist !== undefined && webDist !== '' && existsSync(webDist)) {
    options.staticDir = resolve(webDist);
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
