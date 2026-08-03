import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * 对局表。config/finalState 为 JSON 文本；finalState 在 finishGame 前为 NULL。
 * 声明：服务器重启即丢进行中的对局（内存房间不恢复），本表主要服务复盘/重放（M5）。
 */
export const games = sqliteTable('games', {
  id: text('id').primaryKey(),
  roomCode: text('room_code').notNull(),
  playerCount: integer('player_count').notNull(),
  seed: integer('seed').notNull(),
  config: text('config').notNull(), // JSON: RoomConfig
  status: text('status', { enum: ['playing', 'finished'] }).notNull(),
  createdAt: integer('created_at').notNull(), // epoch ms
  finalState: text('final_state'), // JSON: GameState | null
});

/** 行动流水。(game_id, seq) 唯一——重放校验（Task 5）依赖 seq 单调无洞由上层保证。 */
export const actions = sqliteTable(
  'actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id').notNull(),
    seq: integer('seq').notNull(),
    player: integer('player').notNull(),
    action: text('action').notNull(), // JSON: Action
  },
  (t) => [uniqueIndex('actions_game_id_seq_unique').on(t.gameId, t.seq)],
);

/**
 * 座位与恢复令牌。token 全局唯一（跨对局），由 RoomManager 在 join 时签发、
 * startGame 时随 createGame 落库；开局后 resume 走 findSeatByToken 查库。
 */
export const seats = sqliteTable(
  'seats',
  {
    gameId: text('game_id').notNull(),
    seat: integer('seat').notNull(),
    nickname: text('nickname').notNull(),
    token: text('token').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.seat] }), uniqueIndex('seats_token_unique').on(t.token)],
);

export const schema = { games, actions, seats };
