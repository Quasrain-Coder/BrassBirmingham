/**
 * ActionBar 与 useActionDraft 测试（M2 Task 11 Step 2）。
 * 不变量：draft.resolved 恒为 legalActions 中的原对象（expect(legal).toContain(resolved)）。
 * fixture：engine newGame(4,42) + enumerateActions（真实枚举）；多参数序列用手搓候选。
 */
import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { enumerateActions, newGame, tileDef } from '@brass/engine';
import type { Action, Card, GameState } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import type { FilteredState } from '@brass/protocol';
import { ActionBar, useActionDraft } from './ActionBar';
import type { ActionDraft } from './ActionBar';
import { buildCandidatesAt } from './interactions';

interface Fixture {
  game: GameState;
  state: FilteredState;
  legal: Action[];
  hand: Card[];
}

function freshFixture(): Fixture {
  const game = newGame(4, 42);
  return {
    game,
    state: filterStateFor(game, 0),
    legal: enumerateActions(game, 0),
    hand: game.players[0]!.hand,
  };
}

function renderDraft(f: Fixture, selectedCard: string | null, legal: Action[] = f.legal) {
  return renderHook(
    (props: { card: string | null; legal: Action[] }) =>
      useActionDraft({
        legalActions: props.legal,
        selectedCard: props.card,
        state: f.state,
        seat: 0,
      }),
    { initialProps: { card: selectedCard, legal } },
  );
}

function locationCard(f: Fixture): Card {
  const c = f.hand.find(
    (x) => x.kind === 'location' && f.legal.some((a) => a.type === 'build' && a.cardId === x.id),
  );
  if (c === undefined) throw new Error('fixture 缺可建 location 卡');
  return c;
}

describe('useActionDraft', () => {
  it('选牌后 candidates 过滤 + highlights 含 build 槽位', () => {
    const f = freshFixture();
    const card = locationCard(f);
    const { result } = renderDraft(f, card.id);
    expect(result.current.candidates.length).toBeGreaterThan(0);
    expect(
      result.current.candidates.every(
        (a) => a.type === 'scout' || (a as { cardId?: string }).cardId === card.id,
      ),
    ).toBe(true);
    expect(result.current.highlights.slots?.length).toBeGreaterThan(0);
  });

  it('点击高亮槽位 → resolved 为 legalActions 中匹配的 build 原对象', () => {
    const f = freshFixture();
    const card = locationCard(f);
    const { result } = renderDraft(f, card.id);
    // 找一个无歧义（单一候选）的高亮槽位；双产业槽会进 buildChoices 流程
    const slot = result.current.highlights.slots!.find(
      (s) =>
        buildCandidatesAt(result.current.candidates, s.location, s.slotIndex).length === 1,
    );
    expect(slot).toBeDefined();
    act(() => result.current.clickSlot(slot!.location, slot!.slotIndex));
    expect(result.current.resolved).not.toBeNull();
    expect(result.current.resolved?.type).toBe('build');
    expect(f.legal).toContain(result.current.resolved); // 原对象，非新构造
  });

  it('双产业槽歧义 → buildChoices 待选，choose 后 resolved 为原对象', () => {
    const f = freshFixture();
    const card = locationCard(f);
    const { result } = renderDraft(f, card.id);
    const slot = result.current.highlights.slots!.find(
      (s) =>
        buildCandidatesAt(result.current.candidates, s.location, s.slotIndex).length > 1,
    );
    if (slot === undefined) return; // 该 fixture 无歧义槽则跳过
    act(() => result.current.clickSlot(slot.location, slot.slotIndex));
    expect(result.current.resolved).toBeNull();
    expect(result.current.buildChoices.length).toBeGreaterThan(1);
    const pick = result.current.buildChoices[0]!;
    act(() => result.current.choose(pick));
    expect(result.current.resolved).toBe(pick);
    expect(f.legal).toContain(result.current.resolved);
  });

  it('network 序列：无效点击忽略、逐条收窄、双轨有序、点末条撤销', () => {
    const f = freshFixture();
    const legal: Action[] = [
      { type: 'network', cardId: 'c1', links: [5, 7] },
      { type: 'network', cardId: 'c1', links: [5, 9] },
    ];
    const { result } = renderDraft(f, 'c1', legal);
    act(() => result.current.clickLink(3)); // 非任何候选前缀 → 忽略
    expect(result.current.pickedLinks).toEqual([]);
    act(() => result.current.clickLink(5));
    expect(result.current.pickedLinks).toEqual([5]);
    expect(result.current.resolved).toBeNull(); // 只有双轨候选，单 [5] 不可提交
    act(() => result.current.clickLink(5)); // 点末条撤销
    expect(result.current.pickedLinks).toEqual([]);
    act(() => result.current.clickLink(5));
    act(() => result.current.clickLink(7));
    expect(result.current.resolved).toBe(legal[0]); // 有序对 [5,7]，原对象
  });

  it('develop 多选：乱序两选命中规范化 removals 原对象', () => {
    const f = freshFixture();
    const legal: Action[] = [
      { type: 'develop', cardId: 'c1', removals: ['cotton'] },
      { type: 'develop', cardId: 'c1', removals: ['cotton', 'iron'] },
    ];
    const { result } = renderDraft(f, 'c1', legal);
    act(() => result.current.toggleDevelop('cotton'));
    expect(result.current.resolved).toBe(legal[0]);
    act(() => result.current.toggleDevelop('iron'));
    expect(result.current.developPicks).toEqual(['cotton', 'iron']);
    expect(result.current.resolved).toBe(legal[1]);
    act(() => result.current.toggleDevelop('iron')); // 取消 → 回退单块
    expect(result.current.resolved).toBe(legal[0]);
  });

  it('develop 同产业双研发：再点一次累积 ×2，命中 [x,x] 原对象；第三次点清空该产业', () => {
    const f = freshFixture();
    const legal: Action[] = [
      { type: 'develop', cardId: 'c1', removals: ['cotton'] },
      { type: 'develop', cardId: 'c1', removals: ['cotton', 'cotton'] },
    ];
    const { result } = renderDraft(f, 'c1', legal);
    act(() => result.current.toggleDevelop('cotton'));
    expect(result.current.resolved).toBe(legal[0]);
    act(() => result.current.toggleDevelop('cotton')); // ×2
    expect(result.current.developPicks).toEqual(['cotton', 'cotton']);
    expect(result.current.resolved).toBe(legal[1]);
    act(() => result.current.toggleDevelop('cotton')); // 清空
    expect(result.current.developPicks).toEqual([]);
    expect(result.current.resolved).toBeNull();
  });

  it('develop 无 [x,x] 候选时同产业保持 toggle 语义（不可累积）', () => {
    const f = freshFixture();
    const legal: Action[] = [{ type: 'develop', cardId: 'c1', removals: ['iron'] }];
    const { result } = renderDraft(f, 'c1', legal);
    act(() => result.current.toggleDevelop('iron'));
    act(() => result.current.toggleDevelop('iron')); // 无双研发候选 → 取消
    expect(result.current.developPicks).toEqual([]);
    expect(result.current.resolved).toBeNull();
  });

  it('scout：任意顺序选 3 张命中枚举原对象', () => {
    const f = freshFixture();
    const card = f.hand[0]!;
    const { result } = renderDraft(f, card.id);
    expect(result.current.scoutAvailable).toBe(true);
    act(() => result.current.toggleScoutCard(f.hand[5]!.id));
    act(() => result.current.toggleScoutCard(f.hand[0]!.id));
    expect(result.current.resolved).toBeNull();
    act(() => result.current.toggleScoutCard(f.hand[2]!.id));
    expect(result.current.resolved?.type).toBe('scout');
    expect(f.legal).toContain(result.current.resolved);
  });

  it('sell：choose 单卖原对象；点击板块槽位过滤选项', () => {
    const f = freshFixture();
    const cotton = tileDef('cotton', 1);
    if (cotton === undefined) throw new Error('缺 cotton TileDef');
    // 摆一块自己的未翻面棉板块，sell 候选指向它
    f.state.board.slots['birmingham']![0] = {
      tile: cotton,
      player: 0,
      flipped: false,
      resources: 0,
    };
    const legal: Action[] = [
      {
        type: 'sell',
        cardId: 'c1',
        sales: [
          { location: 'birmingham', slotIndex: 0, merchant: 'oxford', useMerchantBeer: false },
        ],
      },
      {
        type: 'sell',
        cardId: 'c1',
        sales: [
          { location: 'birmingham', slotIndex: 0, merchant: 'oxford', useMerchantBeer: true },
        ],
      },
    ];
    const { result } = renderDraft(f, 'c1', legal);
    expect(result.current.highlights.slots).toContainEqual({
      location: 'birmingham',
      slotIndex: 0,
    });
    act(() => result.current.clickSlot('birmingham', 0));
    expect(result.current.sellTile).toEqual({ location: 'birmingham', slotIndex: 0 });
    act(() => result.current.choose(legal[1]!));
    expect(result.current.resolved).toBe(legal[1]);
  });

  it('loan/pass 无参数：choose 即 resolved', () => {
    const f = freshFixture();
    const card = locationCard(f);
    const { result } = renderDraft(f, card.id);
    const loan = result.current.candidates.find((a) => a.type === 'loan');
    expect(loan).toBeDefined();
    act(() => result.current.choose(loan!));
    expect(result.current.resolved).toBe(loan);
  });

  it('reset 清空参数；换牌后 draft 自动重置', () => {
    const f = freshFixture();
    const card = locationCard(f);
    const { result, rerender } = renderDraft(f, card.id);
    act(() => result.current.toggleDevelop('iron'));
    act(() => result.current.reset());
    expect(result.current.developPicks).toEqual([]);
    act(() => result.current.toggleDevelop('iron'));
    const other = f.hand.find((c) => c.id !== card.id)!;
    rerender({ card: other.id, legal: f.legal });
    expect(result.current.developPicks).toEqual([]);
    expect(result.current.resolved).toBeNull();
  });
});

function draftFixture(overrides: Partial<ActionDraft> = {}): ActionDraft {
  return {
    candidates: [],
    highlights: {},
    pickedLinks: [],
    networkCanExtend: false,
    developPicks: [],
    developChoices: [],
    scoutPicks: [],
    scoutAvailable: false,
    sellSingles: [],
    sellFullSet: null,
    sellTile: null,
    buildChoices: [],
    buildPreview: null,
    resolved: null,
    clickSlot: () => {},
    clickLink: () => {},
    toggleDevelop: () => {},
    toggleScoutCard: () => {},
    choose: () => {},
    reset: () => {},
    ...overrides,
  };
}

describe('<ActionBar>', () => {
  it('非当前玩家：显示"等待 X 行动"', () => {
    render(
      <ActionBar
        myTurn={false}
        waitingFor="乙"
        selectedCard={null}
        hand={[]}
        draft={draftFixture()}
        turnHold={null}
        seat={0}
        onConfirm={() => {}}
        onCancel={() => {}}
        onEndTurn={() => {}}
        onResetTurn={() => {}}
      />,
    );
    expect(screen.getByTestId('waiting')).toHaveTextContent('等待 乙 行动');
  });

  it('当前玩家未选牌：提示选牌，确认钮禁用', () => {
    render(
      <ActionBar
        myTurn
        waitingFor="甲"
        selectedCard={null}
        hand={[]}
        draft={draftFixture()}
        turnHold={null}
        seat={0}
        onConfirm={() => {}}
        onCancel={() => {}}
        onEndTurn={() => {}}
        onResetTurn={() => {}}
      />,
    );
    expect(screen.getByTestId('select-card-hint')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-action')).toBeDisabled();
  });

  it('resolved 后确认钮显示行动描述，点击触发 onConfirm', () => {
    const action: Action = { type: 'loan', cardId: 'c1' };
    let confirmed = 0;
    render(
      <ActionBar
        myTurn
        waitingFor="甲"
        selectedCard="c1"
        hand={[]}
        draft={draftFixture({ resolved: action })}
        turnHold={null}
        seat={0}
        onConfirm={() => {
          confirmed += 1;
        }}
        onCancel={() => {}}
        onEndTurn={() => {}}
        onResetTurn={() => {}}
      />,
    );
    const btn = screen.getByTestId('confirm-action');
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent('贷款');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(confirmed).toBe(1);
  });

  it('scout 模式渲染手牌选择按钮', () => {
    const f = freshFixture();
    const picked: string[] = [];
    render(
      <ActionBar
        myTurn
        waitingFor="甲"
        selectedCard={f.hand[0]!.id}
        hand={f.hand}
        draft={draftFixture({
          scoutAvailable: true,
          scoutPicks: picked,
          toggleScoutCard: (id) => picked.push(id),
        })}
        turnHold={null}
        seat={0}
        onConfirm={() => {}}
        onCancel={() => {}}
        onEndTurn={() => {}}
        onResetTurn={() => {}}
      />,
    );
    const btn = screen.getByTestId(`scout-card-${f.hand[1]!.id}`);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picked).toEqual([f.hand[1]!.id]);
  });
});
