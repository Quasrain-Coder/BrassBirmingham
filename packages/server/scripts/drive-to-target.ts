/**
 * 调试脚本：把指定对局用 HeuristicAgent 离线"快进"到目标状态。
 *
 * 原理：对局状态 = newGame(seed) + 逐条 applyAction(actions 表)。
 * 脚本重放已有行动后继续模拟到终局，只把"目标点之前"的行动追加进
 * actions 表；服务器 resume/重启恢复时重放到目标状态。
 *
 * 用法（在 packages/server 下）：
 *   npx vite-node scripts/drive-to-target.ts [--room 9VYD99 | --game g_xxx]
 *       [--to last-canal-round | last-rail-round | canal:N | rail:N | +N] [--db ./brass.db] [--no-ai]
 *
 *   --to last-canal-round  运河时代最后一轮开局（默认）
 *   --to last-rail-round   铁路时代最后一轮开局（全局最后一轮）
 *   --to canal:N / rail:N  指定时代第 N 轮开局（时代内轮号,引擎 round 跨时代不重置）
 *   --to +N                从当前进度再往前走 N 个行动
 *   --no-ai                把 seats.is_ai 清零。默认保留——resume 时 driveAI 会
 *                          接着打 AI 座位,轮到人类座位自然停下(不会冲过目标)
 *
 * 注意：改的是库；若服务器正在运行且该对局已在内存，需重启服务器后
 * 玩家刷新页面才生效（内存 session 不会自动重放）。
 */
import Database from 'better-sqlite3';
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import type { Action, GameState } from '@brass/engine';
import { HeuristicAgent } from '@brass/llm';

interface Args {
  room: string | undefined;
  game: string | undefined;
  to: string;
  db: string;
  noAi: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { room: undefined, game: undefined, to: 'last-canal-round', db: './brass.db', noAi: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--room': args.room = v; i += 1; break;
      case '--game': args.game = v; i += 1; break;
      case '--to': args.to = v ?? args.to; i += 1; break;
      case '--db': args.db = v ?? args.db; i += 1; break;
      case '--no-ai': args.noAi = true; break;
      default: throw new Error(`未知参数: ${k}`);
    }
  }
  return args;
}

interface GameRow {
  id: string;
  room_code: string;
  player_count: number;
  seed: number;
  status: string;
}

interface Rec {
  player: number;
  action: Action;
  round: number;
  era: string;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.db);

  // 1) 找对局
  let game: GameRow | undefined;
  if (args.game !== undefined) {
    game = db.prepare('SELECT * FROM games WHERE id = ?').get(args.game) as GameRow | undefined;
  } else if (args.room !== undefined) {
    game = db.prepare('SELECT * FROM games WHERE room_code = ?').get(args.room) as GameRow | undefined;
  } else {
    const playing = db.prepare("SELECT * FROM games WHERE status = 'playing'").all() as GameRow[];
    if (playing.length === 1) game = playing[0];
    else throw new Error(`库中有 ${playing.length} 个进行中对局,请用 --room/--game 指定`);
  }
  if (game === undefined) throw new Error('找不到对局');
  console.log(`game: ${game.id} (room=${game.room_code}, ${game.player_count}P, seed=${game.seed}, status=${game.status})`);
  if (game.status !== 'playing') throw new Error(`对局状态 ${game.status},仅支持 playing`);

  // 2) 重放已有行动
  let state: GameState = newGame(game.player_count as 2 | 3 | 4, game.seed);
  const recs: Rec[] = [];
  const record = (s: GameState, player: number, action: Action): void => {
    recs.push({ player, action, round: s.round, era: s.era });
  };
  const existing = db
    .prepare('SELECT seq, player, action FROM actions WHERE game_id = ? ORDER BY seq')
    .all(game.id) as { seq: number; player: number; action: string }[];
  for (const row of existing) {
    const action = JSON.parse(row.action) as Action;
    record(state, row.player, action);
    state = applyAction(state, action);
  }
  console.log(`replayed ${existing.length} actions → era=${state.era} round=${state.round} phase=${state.phase}`);

  // 3) 模拟到终局,记录每步 (round, era)
  const agent = new HeuristicAgent();
  let guard = 0;
  while (state.phase !== 'game-over') {
    guard += 1;
    if (guard > 1000) throw new Error('guard: 行动数超限,疑似死循环');
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    if (legal.length === 0) throw new Error(`seat ${player} 无合法行动,模拟中断`);
    const action = agent.chooseAction(state, legal);
    record(state, player, action);
    state = applyAction(state, action);
  }
  console.log(`simulated to game-over: ${recs.length} actions total`);

  // 4) 计算截断点
  let cutIdx: number;
  const lastRoundOf = (era: string): number => {
    const eraRecs = recs.filter((r) => r.era === era);
    if (eraRecs.length === 0) throw new Error(`模拟中没有 ${era} 时代行动?`);
    const lastRound = eraRecs[eraRecs.length - 1]!.round;
    return recs.findIndex((r) => r.era === era && r.round === lastRound);
  };
  if (args.to === 'last-canal-round' || args.to === 'last-rail-round') {
    cutIdx = lastRoundOf(args.to === 'last-canal-round' ? 'canal' : 'rail');
  } else if (args.to.startsWith('+')) {
    const n = Number.parseInt(args.to.slice(1), 10);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--to ${args.to}: N 须为正整数`);
    cutIdx = Math.min(existing.length + n, recs.length);
  } else {
    const m = /^(canal|rail):(\d+)$/.exec(args.to);
    if (m === null) throw new Error(`--to ${args.to}: 支持 last-canal-round | last-rail-round | canal:N | rail:N | +N`);
    // 引擎 round 跨时代不重置(canal 末轮=8,rail 首轮=9)——N 按时代内轮号映射
    const eraRounds = [...new Set(recs.filter((r) => r.era === m[1]).map((r) => r.round))];
    const targetRound = eraRounds[Number(m[2]) - 1];
    if (targetRound === undefined) throw new Error(`--to ${args.to}: 模拟未到达该状态`);
    cutIdx = recs.findIndex((r) => r.era === m[1] && r.round === targetRound);
  }
  if (cutIdx < existing.length) {
    const cur = recs[existing.length - 1];
    throw new Error(`目标点(seq=${cutIdx})早于当前进度(seq=${existing.length}, ${cur?.era ?? '?'} 第 ${cur?.round ?? '?'} 轮),无需快进或已过头`);
  }
  const target = recs[cutIdx];
  console.log(`target: seq=${cutIdx} → ${target === undefined ? '终局' : `${target.era} 第 ${target.round} 轮开局`}`);

  // 5) 写库
  const ins = db.prepare('INSERT INTO actions (game_id, seq, player, action) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (let i = existing.length; i < cutIdx; i += 1) {
      ins.run(game.id, i, recs[i]!.player, JSON.stringify(recs[i]!.action));
    }
    if (args.noAi) {
      db.prepare('UPDATE seats SET is_ai = 0 WHERE game_id = ?').run(game.id);
    }
  })();
  console.log(`wrote ${cutIdx - existing.length} actions (seq ${existing.length}..${cutIdx - 1})${args.noAi ? ', seats is_ai=0' : ', 保留 is_ai'}`);

  // 6) 校验:全新重放写库后的行动序列
  let chk: GameState = newGame(game.player_count as 2 | 3 | 4, game.seed);
  const rows = db
    .prepare('SELECT player, action FROM actions WHERE game_id = ? ORDER BY seq')
    .all(game.id) as { player: number; action: string }[];
  for (const row of rows) {
    chk = applyAction(chk, JSON.parse(row.action) as Action);
  }
  const cur = chk.turnOrder[chk.currentPlayerIdx]!;
  console.log(
    `verify: era=${chk.era} round=${chk.round} phase=${chk.phase} currentSeat=${cur} ` +
      `deck=${chk.deck.length} hands=[${chk.players.map((p) => p!.hand.length).join(',')}] money=[${chk.players.map((p) => p!.money).join(',')}]`,
  );
  console.log('OK。若服务器正在运行,需重启后玩家刷新页面生效。');
}

main();
