/** 玩家面板坐标(1400×1133 空间,对应 /assets/player-mat.jpg) */
export interface MatSlot {
  level: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAT_IMAGE = { w: 1400, h: 1133 };

/**
 * 各产业等级板块印刷框的内框矩形,按 level 升序。
 * 坐标以 1400×1133 的 player-mat.jpg 为准,框边精度 ±6px。
 */
export const MAT_SLOTS: Record<
  'cotton' | 'manufacturer' | 'pottery' | 'coal' | 'iron' | 'brewery',
  MatSlot[]
> = {
  // 制造厂:顶行横排 III–VIII,左侧竖排 II、I
  manufacturer: [
    { level: 1, x: 87, y: 339, w: 123, h: 120 },
    { level: 2, x: 87, y: 202, w: 123, h: 120 },
    { level: 3, x: 87, y: 60, w: 123, h: 120 },
    { level: 4, x: 307, y: 60, w: 123, h: 120 },
    { level: 5, x: 528, y: 60, w: 123, h: 120 },
    { level: 6, x: 749, y: 60, w: 123, h: 120 },
    { level: 7, x: 969, y: 60, w: 123, h: 120 },
    { level: 8, x: 1190, y: 60, w: 123, h: 120 },
  ],
  // 棉纺厂:左中竖列 IV III II I
  cotton: [
    { level: 1, x: 372, y: 723, w: 128, h: 118 },
    { level: 2, x: 372, y: 585, w: 128, h: 118 },
    { level: 3, x: 372, y: 445, w: 128, h: 118 },
    { level: 4, x: 372, y: 306, w: 128, h: 118 },
  ],
  // 陶器厂:中竖列 IV III II I,右上单独 V
  pottery: [
    { level: 1, x: 670, y: 723, w: 124, h: 118 },
    { level: 2, x: 670, y: 585, w: 124, h: 118 },
    { level: 3, x: 670, y: 445, w: 124, h: 118 },
    { level: 4, x: 670, y: 306, w: 124, h: 118 },
    { level: 5, x: 878, y: 305, w: 128, h: 120 },
  ],
  // 酿酒厂:左边缘竖列 IV III II I
  brewery: [
    { level: 1, x: 89, y: 946, w: 130, h: 122 },
    { level: 2, x: 89, y: 806, w: 130, h: 120 },
    { level: 3, x: 89, y: 666, w: 130, h: 120 },
    { level: 4, x: 89, y: 518, w: 130, h: 128 },
  ],
  // 铁厂:右侧竖列 IV III,右下横排 I II
  iron: [
    { level: 1, x: 948, y: 725, w: 128, h: 120 },
    { level: 2, x: 1170, y: 725, w: 128, h: 120 },
    { level: 3, x: 1170, y: 583, w: 128, h: 120 },
    { level: 4, x: 1170, y: 447, w: 128, h: 120 },
  ],
  // 煤矿:底部横排 I II III IV
  coal: [
    { level: 1, x: 450, y: 957, w: 130, h: 120 },
    { level: 2, x: 667, y: 957, w: 130, h: 120 },
    { level: 3, x: 891, y: 957, w: 130, h: 120 },
    { level: 4, x: 1115, y: 957, w: 130, h: 120 },
  ],
};
