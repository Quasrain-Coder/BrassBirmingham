/**
 * 对局记录导入解析:读取 JSON 文件并校验能从开局重放(顺序/合法性),
 * 通过则返回记录,否则抛出带中文原因的错误。
 */
import { applyAction, newGame } from '@brass/engine';
import type { GameRecord } from '@brass/protocol';

export async function readRecordFile(file: File): Promise<GameRecord> {
  const rec = JSON.parse(await file.text()) as GameRecord;
  if (
    rec === null ||
    typeof rec !== 'object' ||
    rec.version !== 1 ||
    (rec.playerCount !== 2 && rec.playerCount !== 3 && rec.playerCount !== 4) ||
    typeof rec.seed !== 'number' ||
    !Array.isArray(rec.seats) ||
    !Array.isArray(rec.actions)
  ) {
    throw new Error('记录格式非法(需要 version=1 的对局导出文件)');
  }
  let s = newGame(rec.playerCount, rec.seed);
  for (const { player, action } of rec.actions) {
    if (player !== s.turnOrder[s.currentPlayerIdx]) throw new Error('行动者错位,记录不完整');
    s = applyAction(s, action);
  }
  return rec;
}
