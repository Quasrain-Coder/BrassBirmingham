import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * 对局表。config/finalState 为 JSON 文本；finalState 在 finishGame 前为 NULL。
 * status='playing' 的对局在服务器重启后可经 actions 表重放恢复（session restore）；
 * finalState 服务复盘/重放（M5）。
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
 * isAi 标记 AI 座位——服务器重启后重放恢复对局（session restore）时据此重建
 * agents/tokenSeats（AI token 永不进索引，真人 token 才可 resume/submit）。
 */
export const seats = sqliteTable(
  'seats',
  {
    gameId: text('game_id').notNull(),
    seat: integer('seat').notNull(),
    nickname: text('nickname').notNull(),
    token: text('token').notNull(),
    isAi: integer('is_ai', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.seat] }), uniqueIndex('seats_token_unique').on(t.token)],
);

export const schema = { games, actions, seats };
