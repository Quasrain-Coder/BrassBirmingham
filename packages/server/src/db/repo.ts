import Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Action } from '@brass/engine';
import type { RoomConfig } from '@brass/protocol';
import { actions, games, schema, seats } from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

// 无迁移工具（drizzle-kit 未引入）：DDL 内嵌，openDb 幂等建表。
// 注意与 schema.ts 保持一致；测试覆盖全部往返路径。
const DDL = `
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  player_count INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  config TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  final_state TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  player INTEGER NOT NULL,
  action TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS actions_game_id_seq_unique ON actions (game_id, seq);
CREATE TABLE IF NOT EXISTS seats (
  game_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (game_id, seat)
);
CREATE UNIQUE INDEX IF NOT EXISTS seats_token_unique ON seats (token);
`;

/** 打开（必要时创建）数据库。传 ':memory:' 得内存库，测试用。 */
export function openDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(DDL);
  return drizzle(sqlite, { schema });
}

export interface NewGame {
  id: string;
  roomCode: string;
  playerCount: number;
  seed: number;
  config: RoomConfig;
  seats: { seat: number; nickname: string; token: string }[];
}

/** 开局落库：games 行（status='playing'）+ 全部 seats，同事务。 */
export function createGame(db: Db, game: NewGame): void {
  db.transaction((tx) => {
    tx.insert(games)
      .values({
        id: game.id,
        roomCode: game.roomCode,
        playerCount: game.playerCount,
        seed: game.seed,
        config: JSON.stringify(game.config),
        status: 'playing',
        createdAt: Date.now(),
      })
      .run();
    for (const s of game.seats) {
      tx.insert(seats)
        .values({ gameId: game.id, seat: s.seat, nickname: s.nickname, token: s.token })
        .run();
    }
  });
}

/** 追加一条行动。(game_id, seq) 冲突抛 UNIQUE 约束错。 */
export function appendAction(db: Db, gameId: string, seq: number, player: number, action: Action): void {
  db.insert(actions)
    .values({ gameId, seq, player, action: JSON.stringify(action) })
    .run();
}

/** 终局：写 finalState 并把 status 置为 'finished'。 */
export function finishGame(db: Db, gameId: string, finalState: unknown): void {
  db.update(games)
    .set({ status: 'finished', finalState: JSON.stringify(finalState) })
    .where(eq(games.id, gameId))
    .run();
}

export interface GameSummary {
  id: string;
  roomCode: string;
  playerCount: number;
  status: 'playing' | 'finished';
  createdAt: number;
}

export function listGames(db: Db): GameSummary[] {
  return db
    .select({
      id: games.id,
      roomCode: games.roomCode,
      playerCount: games.playerCount,
      status: games.status,
      createdAt: games.createdAt,
    })
    .from(games)
    .all();
}

/** 开局后 resume：token → {gameId, seat}；未命中返回 null。 */
export function findSeatByToken(db: Db, token: string): { gameId: string; seat: number } | null {
  const row = db
    .select({ gameId: seats.gameId, seat: seats.seat })
    .from(seats)
    .where(eq(seats.token, token))
    .get();
  return row ?? null;
}

/** 按 seq 升序取某对局全部行动（Task 5 重放校验用）。 */
export function listActions(db: Db, gameId: string): { seq: number; player: number; action: Action }[] {
  const rows = db
    .select({ seq: actions.seq, player: actions.player, action: actions.action })
    .from(actions)
    .where(eq(actions.gameId, gameId))
    .orderBy(asc(actions.seq))
    .all();
  return rows.map((r) => ({ seq: r.seq, player: r.player, action: JSON.parse(r.action) as Action }));
}
