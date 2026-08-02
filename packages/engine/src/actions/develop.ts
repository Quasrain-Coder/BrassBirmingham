/**
 * Develop 研发行动：枚举 + 执行（rules-reference §6.4，§9.1/§9.16）。
 *
 * - 弃 1 卡（弃牌结算在 Task 11 applyAction，此模块只动面板与铁）；从面板移除 1–2 块
 *   **当前最低级**板块（每个产业栈顶 = 该产业最低级；可不同产业，也可同产业两块——
 *   逐块判定：移一块后重新算该产业栈顶）。
 * - 灯泡图标陶板块（pottery I/III，developable:false）不可移除；移除后板块退出游戏。
 * - 每移除 1 块消耗 1 铁（consumeIron：任意未翻面铁厂免费取、无需连通，不足市场买）。
 *
 * 枚举规范化：removals 按产业固定序（cotton/manufacturer/pottery/coal/iron/brewery）
 * 升序；同产业双块为 [x, x]。只产出完全合法行动（铁计划购买金 ≤ 现金）。
 * applyDevelop 返回新 GameState，本行动产生的事件写入其 lastEvents。
 * 纯函数：不改入参。
 */
import { IllegalActionError } from '../errors.js';
import { buyIronCost } from '../market.js';
import { ironSources } from '../network.js';
import { consumeIron } from '../resources.js';
import type { GameState, PlayerState } from '../state.js';
import type { Action, GameEvent, IndustryType, PlayerIndex } from '../types.js';

/** 产业规范化顺序（removals 排序与枚举顺序，确定性）。 */
const INDUSTRY_ORDER: IndustryType[] = ['cotton', 'manufacturer', 'pottery', 'coal', 'iron', 'brewery'];

/** 面板每个产业的栈顶板块（player.tiles 按产业分组、等级升序，首个即最低级）。 */
function stackTops(ps: PlayerState): Map<IndustryType, number> {
  const tops = new Map<IndustryType, number>();
  for (let i = 0; i < ps.tiles.length; i++) {
    const t = ps.tiles[i]!;
    if (!tops.has(t.industry)) tops.set(t.industry, i);
  }
  return tops;
}

/** 可 Develop 的产业（栈顶 developable），按 INDUSTRY_ORDER 序。 */
function developableIndustries(ps: PlayerState): IndustryType[] {
  const tops = stackTops(ps);
  return INDUSTRY_ORDER.filter((ind) => {
    const idx = tops.get(ind);
    return idx !== undefined && ps.tiles[idx]!.developable;
  });
}

/** 同产业双块是否可行：栈顶两块都 developable（逐块判定：移栈顶后次栈顶成为新栈顶）。 */
function doubleSameIndustryOk(ps: PlayerState, industry: IndustryType): boolean {
  const stack = ps.tiles.filter((t) => t.industry === industry);
  return stack.length >= 2 && stack[0]!.developable && stack[1]!.developable;
}

/** n 块铁的计划市场购买金（与 consumeIron 语义一致；现金不足返回 null）。 */
function plannedIronCost(state: GameState, n: number, cash: number): number | null {
  const free = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
  const fromMarket = Math.max(0, n - free);
  const cost = fromMarket > 0 ? buyIronCost(state, fromMarket) : 0;
  return cost <= cash ? cost : null;
}

/**
 * 枚举完全合法的 Develop 行动（手牌序 → 单块（产业序）→ 双块（产业序对））。
 */
export function enumerateDevelop(state: GameState, player: PlayerIndex): Action[] {
  const ps = state.players[player]!;
  const inds = developableIndustries(ps);
  const out: Action[] = [];
  const cash = ps.money;
  for (const card of ps.hand) {
    if (plannedIronCost(state, 1, cash) !== null) {
      for (const ind of inds) {
        out.push({ type: 'develop', cardId: card.id, removals: [ind] });
      }
    }
    if (plannedIronCost(state, 2, cash) !== null) {
      for (let a = 0; a < inds.length; a++) {
        for (let b = a; b < inds.length; b++) {
          const x = inds[a]!;
          const y = inds[b]!;
          if (x === y && !doubleSameIndustryOk(ps, x)) continue;
          out.push({ type: 'develop', cardId: card.id, removals: [x, y] });
        }
      }
    }
  }
  return out;
}

/**
 * 执行 Develop。先以 enumerateDevelop 校验合法性（不在枚举集内抛 'illegal-develop'），
 * 再逐块移除（每块移除后重算该产业栈顶）并各耗 1 铁。移除的板块退出游戏。
 * 返回新 state；耗铁导致的铁厂翻面事件写入 lastEvents。
 */
export function applyDevelop(
  state: GameState,
  player: PlayerIndex,
  action: Action,
): GameState {
  if (action.type !== 'develop') {
    throw new IllegalActionError('not-a-develop-action', `not-a-develop-action: ${action.type}`);
  }
  const legal = enumerateDevelop(state, player).some(
    (a) =>
      a.type === 'develop' &&
      a.cardId === action.cardId &&
      a.removals.length === action.removals.length &&
      a.removals.every((v, k) => v === action.removals[k]),
  );
  if (!legal) {
    throw new IllegalActionError(
      'illegal-develop',
      `illegal-develop: removals [${action.removals.join(', ')}] with card ${action.cardId}`,
    );
  }

  const events: GameEvent[] = [];
  let next = state;
  for (const industry of action.removals) {
    // 逐块判定：移除后重新算该产业当前最低级（栈顶）
    const psNow = next.players[player]!;
    const idx = psNow.tiles.findIndex((t) => t.industry === industry);
    const players = next.players.slice();
    players[player] = {
      ...psNow,
      tiles: [...psNow.tiles.slice(0, idx), ...psNow.tiles.slice(idx + 1)],
    };
    next = { ...next, players };
    const ri = consumeIron(next, player, 1);
    next = ri.state;
    events.push(...ri.flipped);
  }
  return { ...next, lastEvents: events };
}
