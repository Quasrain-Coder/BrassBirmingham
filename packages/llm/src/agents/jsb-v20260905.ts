/**
 * jsb-v20260905：jsb-v20260903 + 搜寻降权（2026-09-05 GLM-5.3-Flash 对局
 * 复盘驱动的消融幸存项）。
 *
 * 迭代史（见 bench/docs/2026-09-05-jsb-v20260905-ablation.md）：
 * - 原候选含三组旋钮（搜寻降权 + 负收入地板收紧 + 富有罚分放宽），
 *   全量 vs 0903 PAIRED ×200 仅 46%——否决；
 * - 经 BRASS_TUNE6 单变量消融 ×200：搜寻降权单项 58%、贷款组单项 51%，
 *   组合反而 46%（非可加）——裁剪为仅搜寻降权；
 * - 裁剪后扩验 ×300：53.7%（CI ±5.7% 跨 50%），VP 持平——方向为正但
 *   未达仓库切默认门槛（56-63%），保留注册、DEFAULT_SPEC 仍 0903。
 *
 * 依据：a2 复盘「搜寻过度」（5020 P1 两次搜寻垫底、5028 P3 三次搜寻
 * 16VP 运河末全场第 4）——非缺牌场景搜寻每回合 tempo 价值 ~2VP。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260905',
    version: '2.0.0',
    description: '启发式评分 AI（0903 + 搜寻降权；×300 验证 53.7% 未达切默认门槛，保留注册）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0 },
    scout: { maxRefresh: 3.0, deadDiscardValue: 0.72 },
  },
  tuneEnvVar: 'BRASS_TUNE6',
});
