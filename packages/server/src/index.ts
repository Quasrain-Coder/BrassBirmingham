// @brass/server — M2 服务端：WS 权威服务器（ws）+ 房间（rooms）+ 对局会话（session）
// + SQLite 持久化（db）。入口见 main.ts。
export { PROTOCOL_VERSION } from '@brass/protocol';
export { createGameServer } from './ws.js';
export type { GameServer, GameServerOptions } from './ws.js';
