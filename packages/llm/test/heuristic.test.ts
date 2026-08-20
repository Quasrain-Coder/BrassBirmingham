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

  it('returns all actions (sorted) when k >= legal length', () => {
    const s = newGame(4, 42);
    const legal = enumerateActions(s, 0);
    const all = prescreen(s, 0, legal, legal.length + 10);
    expect(all).toHaveLength(legal.length);
  });

  it('returns empty for k = 0', () => {
    const s = newGame(4, 42);
    expect(prescreen(s, 0, enumerateActions(s, 0), 0)).toEqual([]);
  });

  it('类型配额：每种行动类型至少保留该类最高分 1 个', () => {
    const s = newGame(4, 42);
    const legal = enumerateActions(s, 0);
    const kindsInLegal = new Set(legal.map((a) => a.type));
    const picked = prescreen(s, 0, legal, Math.max(kindsInLegal.size, 8));
    const kindsInPicked = new Set(picked.map((a) => a.type));
    // legal 中出现的类型全部在候选里各保留至少 1 个
    expect(kindsInPicked).toEqual(kindsInLegal);
    // 且保留的是该类最高分
    for (const kind of kindsInLegal) {
      const best = Math.max(
        ...legal.filter((a) => a.type === kind).map((a) => scoreAction(s, 0, a)),
      );
      const pickedOfKind = picked.filter((a) => a.type === kind);
      expect(pickedOfKind.some((a) => scoreAction(s, 0, a) === best)).toBe(true);
    }
  });
});

describe('scoreAction components', () => {
  it('pass scores 0 and scout scores the scout weight (-1)', () => {
    const s = newGame(4, 42);
    const legal = enumerateActions(s, 0);
    const pass = legal.find((a) => a.type === 'pass');
    expect(pass).toBeDefined();
    expect(scoreAction(s, 0, pass!)).toBe(0);
    const scout = legal.find((a) => a.type === 'scout');
    if (scout) expect(scoreAction(s, 0, scout)).toBe(HEURISTIC_WEIGHTS.scout);
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
    // 方向性测试：防止比值评分系统性偏好便宜 L1
    const base = withEra(newGame(4, 42), 'rail');
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

  it('loan is positive when cash-short, negative otherwise', () => {
    const s = newGame(4, 42);
    const action: Action = { type: 'loan', cardId: 'any' };
    expect(scoreAction(s, 0, action)).toBe(HEURISTIC_WEIGHTS.loanOtherwise);
    const broke = withMoney(s, 0, 0);
    expect(scoreAction(broke, 0, action)).toBe(
      HEURISTIC_WEIGHTS.loanCashShortage,
    );
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
