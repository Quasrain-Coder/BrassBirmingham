/**
 * 棋盘坐标布局（M2 Task 9）。
 * 坐标为 1000×760 画布的像素值，按真实地理位置归一化投影；
 * 键 = @brass/engine 的 LocationId（22 个，含 farm-north/farm-south）+ MerchantId（5 个）。
 * 坐标表逐字抄录自 task-9-brief.md。
 */

export interface Point {
  x: number;
  y: number;
}

export const BOARD_WIDTH = 1000;
export const BOARD_HEIGHT = 760;

export const LAYOUT: Record<string, Point> = {
  // 城市（22）
  'stoke-on-trent': { x: 95, y: 55 },
  leek: { x: 180, y: 30 },
  belper: { x: 300, y: 25 },
  derby: { x: 310, y: 85 },
  stone: { x: 140, y: 130 },
  uttoxeter: { x: 245, y: 140 },
  'burton-on-trent': { x: 330, y: 185 },
  stafford: { x: 85, y: 205 },
  cannock: { x: 150, y: 245 },
  tamworth: { x: 310, y: 265 },
  wolverhampton: { x: 95, y: 320 },
  walsall: { x: 195, y: 300 },
  nuneaton: { x: 395, y: 285 },
  coalbrookdale: { x: 30, y: 290 },
  dudley: { x: 95, y: 395 },
  birmingham: { x: 215, y: 390 },
  coventry: { x: 380, y: 380 },
  kidderminster: { x: 60, y: 480 },
  worcester: { x: 105, y: 580 },
  redditch: { x: 215, y: 505 },
  'farm-north': { x: 95, y: 150 },
  'farm-south': { x: 55, y: 530 },
  // 商人位（5）
  warrington: { x: 95, y: 5 },
  shrewsbury: { x: 5, y: 240 },
  nottingham: { x: 395, y: 85 },
  gloucester: { x: 60, y: 690 },
  oxford: { x: 330, y: 640 },
};
