import { describe, expect, it } from 'vitest';
import {
  enumerateActions,
  newGame,
  playGame,
  type Action,
  type GameState,
} from '@brass/engine';
import {
  HEURISTIC_WEIGHTS,
  HeuristicAgent,
  prescreen,
  scoreAction,
} from '../src/heuristic.js';

function withEra(state: GameState, era: GameState['era']): GameState {
  return { ...state, era };
}

/** 把 player 面板里某产业低于 minLevel 的板块全部移除（栈顶变成高级板块）。 */
function withStackTopAtLeast(
  state: GameState,
  player: number,
  industry: 'cotton',
  minLevel: number,
): GameState {
  return {
    ...state,
    players: state.players.map((p, i) =>
      i === player
        ? {
            ...p,
            tiles: p.tiles.filter(
              (t) => t.industry !== industry || t.level >= minLevel,
            ),
          }
        : p,
    ),
  };
}

function withMoney(state: GameState, player: number, money: number): GameState {
  return {
    ...state,
    players: state.players.map((p, i) =>
      i === player ? { ...p, money } : p,
    ),
  };
}

describe('prescreen', () => {
  it('returns top-k by score, deterministic', () => {
    const s = newGame(4, 42);
    const legal = enumerateActions(s, 0);
    const top8 = prescreen(s, 0, legal, 8);
    expect(top8).toHaveLength(8);
    const scores = top8.map((a) => scoreAction(s, 0, a));
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    expect(prescreen(s, 0, legal, 8)).toEqual(top8); // 确定性
  });

  it('cardId 去重：k 足够大时返回所有不同选择（每种一份，忽略弃哪张卡）', () => {
    const s = newGame(4, 42);
    const legal = enumerateActions(s, 0);
    const all = prescreen(s, 0, legal, legal.length + 10);
    // 至少与"按去 cardId 签名去重"的集合大小一致，且远小于含 cardId 的 legal 全量
    const sigs = new Set(
      legal.map((a) => JSON.stringify({ ...a, cardId: undefined })),
    );
    expect(all.length).toBeLessThanOrEqual(sigs.size);
    expect(all.length).toBeGreaterThan(0);
    // 每个不同签名只出现一次
    const seen = new Set<string>();
    for (const a of all) {
      const sig = JSON.stringify({ ...a, cardId: undefined });
      expect(seen.has(sig)).toBe(false);
      seen.add(sig);
    }
  });

  it('returns empty for k = 0', () => {
    const s = newGame(4, 42);
    expect(prescreen(s, 0, enumerateActions(s, 0), 0)).toEqual([]);
  });

  it('类型配额：每种候选类型至少保留该类最高分 1 个（自杀贷款被剔除除外）', () => {
    const s = newGame(4, 42);
    const legal = enumerateActions(s, 0);
    const kindsInLegal = new Set(legal.map((a) => a.type));
    const picked = prescreen(s, 0, legal, Math.max(kindsInLegal.size, 8));
    const kindsInPicked = new Set(picked.map((a) => a.type));
    // 候选类型 ⊆ legal 类型；loan 可能因"贷后收入为负"被消毒剔除
    expect([...kindsInPicked].every((k) => kindsInLegal.has(k))).toBe(true);
    // 且保留的是该类最高分
    for (const kind of kindsInPicked) {
      const best = Math.max(
        ...legal.filter((a) => a.type === kind).map((a) => scoreAction(s, 0, a)),
      );
      const pickedOfKind = picked.filter((a) => a.type === kind);
      expect(pickedOfKind.some((a) => scoreAction(s, 0, a) === best)).toBe(true);
    }
  });
});

describe('scoreAction components', () => {
  it('pass scores negative (never neutral) and scout scores above pass', () => {
    const s = newGame(4, 42);
    const legal = enumerateActions(s, 0);
    const pass = legal.find((a) => a.type === 'pass');
    expect(pass).toBeDefined();
    expect(scoreAction(s, 0, pass!)).toBe(HEURISTIC_WEIGHTS.pass);
    expect(HEURISTIC_WEIGHTS.pass).toBeLessThan(0);
    const scout = legal.find((a) => a.type === 'scout');
    // scout 按所弃 3 卡的保留价值动态评分（不再是常数），但应显著优于 pass
    if (scout) {
      const v = scoreAction(s, 0, scout);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(HEURISTIC_WEIGHTS.pass);
    }
  });

  it('prefers building income-positive tiles over pass in opening', () => {
    // 开局 £17：build 类行动最高分应 > pass 的 0 分
    const s = newGame(4, 42);
    const legal = enumerateActions(s, 0);
    const builds = legal.filter((a) => a.type === 'build');
    expect(builds.length).toBeGreaterThan(0);
    const best = Math.max(...builds.map((a) => scoreAction(s, 0, a)));
    expect(best).toBeGreaterThan(0);
  });

  it('scores L4 cotton above L1 cotton in the rail era', () => {
    // 方向性测试：防止比值评分系统性偏好便宜 L1。
    // 注意新评分对"买不起"硬折价，需给足现金让两者都可负担才比得出方向。
    const base = withMoney(withEra(newGame(4, 42), 'rail'), 0, 60);
    const action: Action = {
      type: 'build',
      cardId: 'any',
      industry: 'cotton',
      location: 'derby',
    };
    const l1 = scoreAction(base, 0, action);
    const l4state = withStackTopAtLeast(base, 0, 'cotton', 4);
    const l4 = scoreAction(l4state, 0, action);
    expect(l4).toBeGreaterThan(l1);
  });

  it('loan scores higher when cash-short than when rich', () => {
    // 新评分（brass-assistant 移植）：创业贷款峰值 + 闲置保护 vs 富裕惩罚
    const s = newGame(4, 42);
    const action: Action = { type: 'loan', cardId: 'any' };
    const broke = scoreAction(withMoney(s, 0, 0), 0, action);
    const rich = scoreAction(withMoney(s, 0, 60), 0, action);
    expect(Number.isFinite(broke)).toBe(true);
    expect(Number.isFinite(rich)).toBe(true);
    expect(broke).toBeGreaterThan(rich);
  });
});

describe('HeuristicAgent', () => {
  it('always returns a legal action', () => {
    const s = newGame(4, 7);
    const legal = enumerateActions(s, 0);
    expect(legal).toContainEqual(new HeuristicAgent().chooseAction(s, legal));
  });

  it('decide returns a degraded Decision wrapping a legal action', async () => {
    const s = newGame(4, 7);
    const legal = enumerateActions(s, 0);
    const d = await new HeuristicAgent().decide(s, 0, legal);
    expect(legal).toContainEqual(d.action);
    expect(d.degraded).toBe(true);
    expect(d.usage).toEqual({ input: 0, output: 0 });
    expect(typeof d.reason).toBe('string');
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it('full heuristic-vs-heuristic game terminates (4p)', () => {
    const agents = Array.from({ length: 4 }, () => new HeuristicAgent());
    const { state } = playGame(4, 7, agents);
    expect(state.phase).toBe('game-over');
    expect(state.winner).not.toBeNull();
  });

  it('full heuristic-vs-heuristic game terminates (2p)', () => {
    const agents = Array.from({ length: 2 }, () => new HeuristicAgent());
    const { state } = playGame(2, 11, agents);
    expect(state.phase).toBe('game-over');
  });
});
