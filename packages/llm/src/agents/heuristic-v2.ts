/**
 * heuristic-v2：启发式 AI 第二版（brass-assistant 2026-08-29 重构版，统一翻面
 * 概率模型 + ScoreParts 评分分解）——移植中，当前为占位实现（暂回落 v1 逻辑，
 * 移植完成后本文件整体替换，契约不变）。
 */
import { HeuristicAgent } from '../heuristic.js';
import type { AgentPlugin } from './contract.js';

const plugin: AgentPlugin = {
  meta: {
    name: 'heuristic-v2',
    version: '0.0.0-wip',
    description: '启发式评分 AI v2（统一翻面概率模型，brass-assistant 8/29 重构版移植，WIP）',
    author: 'brass-birmingham',
  },
  create: () => {
    const inner = new HeuristicAgent();
    return {
      decide: async ({ state, seat, legal }) => (await inner.decide(state, seat, legal)).action,
    };
  },
};

export default plugin;
