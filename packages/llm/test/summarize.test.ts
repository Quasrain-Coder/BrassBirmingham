import { describe, expect, it } from 'vitest';
import {
  LOCATIONS,
  applyAction,
  enumerateActions,
  newGame,
  type Action,
  type GameState,
} from '@brass/engine';
import {
  buildDecisionPrompt,
  describeAction,
  summarizeState,
} from '../src/summarize.js';

/** 连打 n 步（每步取合法集首个行动），得到有场上内容的中局状态。 */
function playSteps(seed: number, n: number): GameState {
  let s = newGame(4, seed);
  for (let i = 0; i < n; i++) {
    const p = s.turnOrder[s.currentPlayerIdx]!;
    const legal = enumerateActions(s, p);
    s = applyAction(s, legal[0]!);
  }
  return s;
}

function findAction<T extends Action['type']>(
  state: GameState,
  player: number,
  type: T,
): Extract<Action, { type: T }> | undefined {
  return enumerateActions(state, player).find((a) => a.type === type) as
    | Extract<Action, { type: T }>
    | undefined;
}

describe('summarizeState', () => {
  it('开局摘要包含关键事实：时代/轮次/现金/收入/VP/手牌/市场/甲板', () => {
    const s = newGame(4, 42);
    const text = summarizeState(s, 0);
    expect(text).toContain('运河时代');
    expect(text).toContain('第1轮');
    expect(text).toContain('£17'); // 开局现金
    expect(text).toContain('收入等级0');
    expect(text).toContain('VP0');
    // 手牌逐张：每张卡 id 都出现
    for (const c of s.players[0]!.hand) {
      expect(text).toContain(c.id);
    }
    // 市场：存量 + 下一块价格（煤 13 块下块 £1，铁 8 块下块 £1）
    expect(text).toContain(`煤:存${s.coalMarket}块`);
    expect(text).toContain(`铁:存${s.ironMarket}块`);
    expect(text).toContain('下块£1');
    // 甲板余量
    expect(text).toContain(`余${s.deck.length}张`);
  });

  it('只展示 viewer 手牌（对手手牌 id 不出现）', () => {
    const s = newGame(4, 42);
    const text = summarizeState(s, 0);
    for (const c of s.players[1]!.hand) {
      expect(text).not.toContain(c.id);
    }
  });

  it('中局摘要包含场上板块（地点+翻面态）、Link、啤酒、商人桶', () => {
    const s = playSteps(42, 8);
    const text = summarizeState(s, s.turnOrder[s.currentPlayerIdx]!);
    expect(text).toContain('【场上板块】');
    expect(text).toMatch(/[未已]翻/);
    expect(text).toContain('【Link】');
    expect(text).toContain('【啤酒】');
    expect(text).toContain('商人桶');
    // 已建板块的地点显示名出现在摘要里
    const built = Object.entries(s.board.slots).find(([, slots]) =>
      slots.some((t) => t !== null),
    );
    expect(built).toBeDefined();
    expect(text).toContain(LOCATIONS[built![0]]!.name);
  });

  it('确定性：同状态两次调用逐字节相同', () => {
    const s = playSteps(7, 12);
    const p = s.turnOrder[s.currentPlayerIdx]!;
    expect(summarizeState(s, p)).toBe(summarizeState(s, p));
  });

  it('紧凑：中局摘要长度有界（目标 < 1200 token，约 3000 字符上限）', () => {
    const s = playSteps(7, 24);
    const text = summarizeState(s, s.turnOrder[s.currentPlayerIdx]!);
    expect(text.length).toBeLessThan(3000);
  });
});

describe('describeAction', () => {
  it('build：含地点、等级、产业、成本与翻面收益', () => {
    const s = newGame(4, 42);
    const build = findAction(s, 0, 'build');
    expect(build).toBeDefined();
    const d = describeAction(s, 0, build!);
    expect(d).toContain('建');
    expect(d).toMatch(/\d级/);
    expect(d).toContain('£');
    expect(d).toContain('翻面');
    expect(d).toContain('收入');
  });

  it('build 煤矿连通商人位时标注市场售卖预期', () => {
    const s = newGame(4, 42);
    const legal = enumerateActions(s, 0).filter(
      (a): a is Extract<Action, { type: 'build' }> =>
        a.type === 'build' && a.industry === 'coal',
    );
    // 找一个标注了建成即卖的描述（若该 seed 有连通煤矿可建）
    const descs = legal.map((a) => describeAction(s, 0, a));
    for (const d of descs) expect(d).toContain('煤矿');
    // 不强求每个 seed 都有连通点；有卖市场标注时必须带金额
    for (const d of descs.filter((x) => x.includes('卖市场'))) {
      expect(d).toMatch(/卖市场≈£\d+/);
    }
  });

  it('network（运河时代）：含端点与 £3', () => {
    const s = newGame(4, 42);
    const net = findAction(s, 0, 'network');
    expect(net).toBeDefined();
    const d = describeAction(s, 0, net!);
    expect(d).toContain('运河');
    expect(d).toContain('£3');
  });

  it('develop/loan/scout/pass 各有类型关键字', () => {
    const s = newGame(4, 42);
    const dev = findAction(s, 0, 'develop');
    if (dev) expect(describeAction(s, 0, dev)).toContain('研发');
    const loan = findAction(s, 0, 'loan');
    expect(loan).toBeDefined();
    expect(describeAction(s, 0, loan!)).toContain('£30');
    expect(describeAction(s, 0, loan!)).toContain('贷款');
    const scout = findAction(s, 0, 'scout');
    if (scout) expect(describeAction(s, 0, scout)).toContain('侦察');
    const pass = findAction(s, 0, 'pass');
    expect(pass).toBeDefined();
    expect(describeAction(s, 0, pass!)).toContain('跳过');
  });

  it('sell：含卖出地点、商人、翻面收益与啤酒来源', () => {
    // 多打几步直到出现合法 sell（启发式首位打法能较快建出棉/制造）
    let s = newGame(4, 3);
    let sell: Extract<Action, { type: 'sell' }> | undefined;
    let p = 0;
    for (let i = 0; i < 80 && !sell; i++) {
      p = s.turnOrder[s.currentPlayerIdx]!;
      const legal = enumerateActions(s, p);
      sell = legal.find((a) => a.type === 'sell') as typeof sell;
      if (!sell) s = applyAction(s, legal[0]!);
    }
    expect(sell).toBeDefined();
    const d = describeAction(s, p, sell!);
    expect(d).toContain('卖出');
    expect(d).toContain('→');
    expect(d).toMatch(/啤酒|商人桶|酒厂/);
    expect(d).toContain('翻面');
  });
});

describe('buildDecisionPrompt', () => {
  function candidates(s: GameState, p: number) {
    return enumerateActions(s, p)
      .slice(0, 8)
      .map((action) => ({ action, description: describeAction(s, p, action) }));
  }

  it('system 完全静态：两局不同 seed 逐字节相同（缓存友好）', () => {
    const s1 = newGame(4, 1);
    const s2 = newGame(4, 999);
    const p1 = buildDecisionPrompt(s1, 0, candidates(s1, 0));
    const p2 = buildDecisionPrompt(s2, 1, candidates(s2, 1));
    expect(p1.system).toBe(p2.system);
  });

  it('system 不含任何对局动态内容（无现金数/卡 id/地点占据）', () => {
    const s = newGame(4, 42);
    const { system } = buildDecisionPrompt(s, 0, candidates(s, 0));
    expect(system).not.toContain('£17');
    expect(system).not.toContain('第1轮');
    for (const c of s.players[0]!.hand) {
      expect(system).not.toContain(c.id);
    }
    // 输出方式说明在 system 里（稳定前缀的一部分）：tool use 口径，不提 JSON 自由文本
    expect(system).toContain('choose 工具');
    expect(system).not.toContain('JSON');
  });

  it('user = 局势摘要 + 0-based 连续编号候选列表', () => {
    const s = newGame(4, 42);
    const cands = candidates(s, 0);
    const { user } = buildDecisionPrompt(s, 0, cands);
    expect(user).toContain('【局势】');
    for (let i = 0; i < cands.length; i++) {
      expect(user).toContain(`${i}. ${cands[i]!.description}`);
    }
    // 编号连续：无跳号（i+1 的行不存在于候选区开头语义，用行级检查）
    const lines = user.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(lines).toHaveLength(cands.length);
    lines.forEach((l, i) => expect(l.startsWith(`${i}. `)).toBe(true));
  });

  it('确定性：同状态同候选两次构造逐字节相同', () => {
    const s = newGame(4, 42);
    const cands = candidates(s, 0);
    expect(buildDecisionPrompt(s, 0, cands)).toEqual(
      buildDecisionPrompt(s, 0, cands),
    );
  });
});
