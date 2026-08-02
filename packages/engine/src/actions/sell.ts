/**
 * Sell 卖货行动：枚举 + 执行（rules-reference §6.5，§1.3，§9.11/§9.12）。
 *
 * 规则要点：
 * - 选自己未翻面的棉/制造/陶板块，须连通到**印有对应图标的商人板块**
 *   （'any' 板块收任意货；'blank' 不算）。连通 = 板块所在地点沿当前时代已建边
 *   （任何玩家的）可达该商人位（reachableFrom，§6.5）。
 * - 每块板块各自检查图标连通与啤酒；一次行动可翻多块（混合产业，§9.11）。
 * - 啤酒 = 板块右上 beerToFlip（可为 0）。来源由 consumeBeer 解析：①useMerchantBeer
 *   时取**所卖向那个商人位**的桶（每次销售至多 1 桶，用了发 MerchantBonusEvent，
 *   §9.12：可选、用了才给奖励、只能取所卖向商人的桶）②自己未翻面酒厂（无需连通）
 *   ③对手未翻面酒厂（须连通用酒处 = 所卖向商人位）。啤酒不足（含可选商人桶在内
 *   的全部合法来源）则该板块不可卖、对应组合不枚举。
 * - 连锁翻面：耗尽对手（或自己）酒厂最后一桶 → owner 立即翻面进收入
 *   （consumeBeer 的 drain/applyFlip 已处理）。
 * - 商人奖励：vp/money/income 由 consumeBeer 直接结算；**gloucester 的免费
 *   develop 在本模块结算**——收到 merchant='gloucester' 的 MerchantBonusEvent 后
 *   移除面板 1 块最低级板块（不耗铁；灯泡陶 developable:false 不可移除）。
 *   规范化目标：产业序（cotton/manufacturer/pottery/coal/iron/brewery）首个
 *   可研发的产业栈顶；面板无可移除板块时奖励落空（官方为可选奖励）。
 *
 * 枚举规范化（task-10-brief）：
 * - 单块销售全枚举：板块 × 可达匹配商人位 × useMerchantBeer∈{true,false}
 *   （true 分支仅当该商人位有桶时存在）。
 * - 多块只枚举"可卖全集"一个行动：按规范化顺序（location 字典序 + 槽位序）
 *   贪心模拟——每块取首个可行（商人位 id 序；有桶则先用商人桶）的（商人位,
 *   useMerchantBeer），在模拟态上实际消耗啤酒后再定下一块；某块无可行来源
 *   （啤酒被前序销售耗尽）则该块不进全集。**中间子集不枚举（v1 已知简化，
 *   LLM/前端可用连续两次 Sell 逼近）**；全集 <2 块时不重复枚举（单块已覆盖）。
 * - 可行性判定直接调 consumeBeer 试跑（捕获 'insufficient-beer'），保证
 *   枚举出的行动 apply 必成功。
 *
 * 弃 1 张行动卡的结算不在此模块（Task 11 applyAction 统一处理）；applySell
 * 不动 hand/discard。返回 { state, events }（与 applyBuild 一致，不写 lastEvents）。
 * 纯函数：不改入参。
 */
import { MERCHANTS } from '../data/board.js';
import { IllegalActionError } from '../errors.js';
import { reachableFrom } from '../network.js';
import { applyFlip, consumeBeer } from '../resources.js';
import type { GameState, PlayerState } from '../state.js';
import type {
  Action,
  GameEvent,
  IndustryType,
  LocationId,
  MerchantId,
  PlayerIndex,
} from '../types.js';

type SellAction = Extract<Action, { type: 'sell' }>;
type Sale = SellAction['sales'][number];

const MERCHANT_IDS = Object.keys(MERCHANTS) as MerchantId[];

/** gloucester 免费 develop 的规范化移除顺序（与 develop.ts 一致）。 */
const INDUSTRY_ORDER: IndustryType[] = [
  'cotton',
  'manufacturer',
  'pottery',
  'coal',
  'iron',
  'brewery',
];

interface SellableTile {
  location: LocationId;
  slotIndex: number;
  industry: IndustryType;
  beerToFlip: number;
}

/** 玩家场上未翻面的可卖板块（棉/制造/陶），按 location 字典序 + 槽位序（规范化）。 */
function sellableTiles(state: GameState, player: PlayerIndex): SellableTile[] {
  const out: SellableTile[] = [];
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (let i = 0; i < slots.length; i++) {
      const t = slots[i];
      if (t && t.player === player && !t.flipped && t.tile.sellable) {
        out.push({
          location: loc,
          slotIndex: i,
          industry: t.tile.industry,
          beerToFlip: t.tile.beerToFlip,
        });
      }
    }
  }
  out.sort(
    (a, b) =>
      (a.location < b.location ? -1 : a.location > b.location ? 1 : 0) ||
      a.slotIndex - b.slotIndex,
  );
  return out;
}

/** 啤酒可行性：与 consumeBeer 语义完全一致（试跑，仅吞 'insufficient-beer'）。 */
function beerFeasible(
  state: GameState,
  player: PlayerIndex,
  n: number,
  merchant: MerchantId,
  useMerchantBeer: boolean,
): boolean {
  try {
    consumeBeer(state, player, n, { at: merchant, useMerchantBeer });
    return true;
  } catch (e) {
    if (e instanceof IllegalActionError && e.code === 'insufficient-beer') return false;
    throw e;
  }
}

/**
 * 单块板块的全部可行 sale（对给定 state）：可达且图标匹配的商人位
 * （MERCHANTS 键序）× useMerchantBeer（有桶则 true 在前，false 恒在）。
 */
function saleOptions(state: GameState, player: PlayerIndex, tile: SellableTile): Sale[] {
  const reach = reachableFrom(state, [tile.location]);
  const out: Sale[] = [];
  for (const merchant of MERCHANT_IDS) {
    if (!reach.has(merchant)) continue;
    const m = state.merchants[merchant];
    if (!m.tiles.some((t) => t === 'any' || t === tile.industry)) continue;
    const flags = m.beer > 0 ? [true, false] : [false];
    for (const useMerchantBeer of flags) {
      if (!beerFeasible(state, player, tile.beerToFlip, merchant, useMerchantBeer)) continue;
      out.push({
        location: tile.location,
        slotIndex: tile.slotIndex,
        merchant,
        useMerchantBeer,
      });
    }
  }
  return out;
}

/**
 * "可卖全集"的贪心规范化：按板块规范化顺序，逐块取首个可行 sale 并在模拟态上
 * 实际消耗啤酒；无可行来源的板块不进全集（啤酒被前序销售耗尽）。
 */
function fullSetSales(state: GameState, player: PlayerIndex, tiles: SellableTile[]): Sale[] {
  const sales: Sale[] = [];
  let sim = state;
  for (const tile of tiles) {
    const sale = saleOptions(sim, player, tile)[0];
    if (!sale) continue;
    sales.push(sale);
    sim = consumeBeer(sim, player, tile.beerToFlip, {
      at: sale.merchant,
      useMerchantBeer: sale.useMerchantBeer,
    }).state;
  }
  return sales;
}

/**
 * 枚举完全合法的 Sell 行动：手牌每张卡 ×（每块单卖全组合 + 可卖全集一个）。
 * 顺序确定性：手牌序 → 板块规范化序 → 商人位 id 序 → useMerchantBeer(true→false)。
 */
export function enumerateSells(state: GameState, player: PlayerIndex): Action[] {
  const ps = state.players[player]!;
  const tiles = sellableTiles(state, player);
  if (tiles.length === 0) return [];
  const singles = tiles.map((t) => saleOptions(state, player, t));
  const full = fullSetSales(state, player, tiles);
  const out: Action[] = [];
  for (const card of ps.hand) {
    for (const opts of singles) {
      for (const sale of opts) {
        out.push({ type: 'sell', cardId: card.id, sales: [sale] });
      }
    }
    if (full.length >= 2) {
      out.push({ type: 'sell', cardId: card.id, sales: full });
    }
  }
  return out;
}

/** sales 规范化比较：按 (location, slotIndex, merchant, useMerchantBeer) 排序后逐项相等。 */
function sameSales(a: Sale[], b: Sale[]): boolean {
  if (a.length !== b.length) return false;
  const key = (s: Sale): string =>
    `${s.location}${s.slotIndex}${s.merchant}${s.useMerchantBeer ? 1 : 0}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((k, i) => k === sb[i]);
}

/** gloucester 免费 develop：移除产业序首个可研发产业的栈顶板块（不耗铁）；无可移除则落空。 */
function settleFreeDevelop(state: GameState, player: PlayerIndex): GameState {
  const ps: PlayerState = state.players[player]!;
  const tops = new Map<IndustryType, number>();
  for (let i = 0; i < ps.tiles.length; i++) {
    const t = ps.tiles[i]!;
    if (!tops.has(t.industry)) tops.set(t.industry, i);
  }
  for (const ind of INDUSTRY_ORDER) {
    const idx = tops.get(ind);
    if (idx === undefined || !ps.tiles[idx]!.developable) continue;
    const players = state.players.slice();
    players[player] = {
      ...ps,
      tiles: [...ps.tiles.slice(0, idx), ...ps.tiles.slice(idx + 1)],
    };
    return { ...state, players };
  }
  return state;
}

/**
 * 执行 Sell。先以 enumerateSells 校验合法性（不在枚举集内抛 'illegal-sell'），
 * 再按 sales 顺序逐块结算：耗啤酒（来源翻面事件在前）→ 商人奖励（vp/money/income
 * 已由 consumeBeer 结算；gloucester 在此免费 develop）→ 板块翻面进收入。
 * 弃牌不在此结算（Task 11）。
 */
export function applySell(
  state: GameState,
  player: PlayerIndex,
  action: Action,
): { state: GameState; events: GameEvent[] } {
  if (action.type !== 'sell') {
    throw new IllegalActionError('not-a-sell-action', `not-a-sell-action: ${action.type}`);
  }
  const legal = enumerateSells(state, player).some(
    (a) => a.type === 'sell' && a.cardId === action.cardId && sameSales(a.sales, action.sales),
  );
  if (!legal) {
    throw new IllegalActionError(
      'illegal-sell',
      `illegal-sell: ${action.sales.length} sale(s) with card ${action.cardId}`,
    );
  }

  const events: GameEvent[] = [];
  let next = state;
  for (const sale of action.sales) {
    const placed = next.board.slots[sale.location]?.[sale.slotIndex];
    if (!placed) {
      throw new IllegalActionError(
        'illegal-sell',
        `illegal-sell: no tile at ${sale.location} slot ${sale.slotIndex}`,
      );
    }
    const rb = consumeBeer(next, player, placed.tile.beerToFlip, {
      at: sale.merchant,
      useMerchantBeer: sale.useMerchantBeer,
    });
    next = rb.state;
    events.push(...rb.flipped);
    if (rb.merchantBonus) {
      events.push(rb.merchantBonus);
      if (MERCHANTS[sale.merchant].bonus.type === 'develop') {
        next = settleFreeDevelop(next, player);
      }
    }
    const f = applyFlip(next, sale.location, sale.slotIndex);
    next = f.state;
    events.push(f.event);
  }
  return { state: next, events };
}
