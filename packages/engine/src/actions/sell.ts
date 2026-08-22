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
 * 枚举规范化（task-10-brief，2026-08-20 修订）：
 * - 单块销售全枚举：板块 × 可达匹配商人位 × useMerchantBeer∈{true,false}
 *   （true 分支仅当该商人位有桶且板块 beerToFlip>0 时存在）。
 * - 多块枚举"最大可卖集合"（回溯求一次行动可卖的最多块数——贪心取首项
 *   会让前序板块抢走稀缺啤酒、后序板块无可行来源，漏掉合法组合）及其全部
 *   "减一"子集（规则书 p.10 step 5：每追加一块都是可选的；可行集的保序子序列
 *   必可行——啤酒消耗只会更少）。更小的中间子集不枚举（可用连续两次 Sell
 *   逼近）；最大集 <2 块时不重复枚举（单块已覆盖）。
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
import { applyFlip, consumeBeer, merchantHasUsableBarrel } from '../resources.js';
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
  industry: IndustryType,
): boolean {
  try {
    consumeBeer(state, player, n, { at: merchant, useMerchantBeer, industry });
    return true;
  } catch (e) {
    if (e instanceof IllegalActionError && e.code === 'insufficient-beer') return false;
    throw e;
  }
}

/**
 * 单块板块的全部可行 sale（对给定 state）：可达且图标匹配的商人位
 * （MERCHANTS 插入序）× useMerchantBeer（有桶且 beerToFlip>0 则 true 在前，false 恒在）。
 */
function saleOptions(state: GameState, player: PlayerIndex, tile: SellableTile): Sale[] {
  const reach = reachableFrom(state, [tile.location]);
  const out: Sale[] = [];
  for (const merchant of MERCHANT_IDS) {
    if (!reach.has(merchant)) continue;
    const m = state.merchants[merchant];
    if (!m.tiles.some((t) => t === 'any' || t === tile.industry)) continue;
    // useMerchantBeer:true 分支仅当存在"收该产业的板块格"旁的剩桶且板块确实需要啤酒
    // （beerToFlip=0 的板块无从消耗商人桶、无从触发奖励）
    const flags =
      tile.beerToFlip > 0 && merchantHasUsableBarrel(m, tile.industry) ? [true, false] : [false];
    for (const useMerchantBeer of flags) {
      if (!beerFeasible(state, player, tile.beerToFlip, merchant, useMerchantBeer, tile.industry)) continue;
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
 * "最大可卖集合"的回溯规范化：按板块规范化序 DFS，逐块尝试全部可行 sale
 * （选项序确定性），在模拟态上实际消耗啤酒；返回一次行动可卖的**最多块数**
 * 的可行组合（并列取 DFS 先序首个，确定性）。贪心取首项会让前序板块抢走
 * 稀缺啤酒、后序板块无可行来源，漏掉合法组合，故回溯。
 */
function maxSetSales(state: GameState, player: PlayerIndex, tiles: SellableTile[]): Sale[] {
  let best: Sale[] = [];
  const dfs = (i: number, sim: GameState, acc: Sale[]): void => {
    // 剪枝：剩余板块全部可卖也无法超过 best
    if (acc.length + (tiles.length - i) <= best.length) return;
    if (i === tiles.length) {
      best = acc.slice();
      return;
    }
    const tile = tiles[i]!;
    for (const sale of saleOptions(sim, player, tile)) {
      const sim2 = consumeBeer(sim, player, tile.beerToFlip, {
        at: sale.merchant,
        useMerchantBeer: sale.useMerchantBeer,
        industry: tile.industry,
      }).state;
      dfs(i + 1, sim2, [...acc, sale]);
    }
    dfs(i + 1, sim, acc);
  };
  dfs(0, state, []);
  return best;
}

/**
 * 枚举完全合法的 Sell 行动：手牌每张卡 ×（每块单卖全组合 + 最大可卖集合
 * + 最大集的全部"减一"子集）。
 * 顺序确定性：手牌序 → 板块规范化序 → MERCHANTS 插入序 → useMerchantBeer(true→false)。
 */
export function enumerateSells(state: GameState, player: PlayerIndex): Action[] {
  const ps = state.players[player]!;
  const tiles = sellableTiles(state, player);
  if (tiles.length === 0) return [];
  const singles = tiles.map((t) => saleOptions(state, player, t));
  const full = maxSetSales(state, player, tiles);
  const out: Action[] = [];
  for (const card of ps.hand) {
    for (const opts of singles) {
      for (const sale of opts) {
        out.push({ type: 'sell', cardId: card.id, sales: [sale] });
      }
    }
    if (full.length >= 2) {
      out.push({ type: 'sell', cardId: card.id, sales: full });
      // 中间子集（规则书 p.10 step 5：每追加一块都是可选的）：最大集的全部
      // "减一"保序子序列（可行集的子序列啤酒消耗只会更少，必可行）。
      // full.length === 2 时减一即单块，已被上面的单卖枚举覆盖。
      for (let k = full.length - 1; k >= 0 && full.length >= 3; k--) {
        out.push({
          type: 'sell',
          cardId: card.id,
          sales: [...full.slice(0, k), ...full.slice(k + 1)],
        });
      }
    }
  }
  return out;
}

/**
 * 组合式合法性校验（2026-08-21 修订,支持客户端分组自由组合）：
 * 不再要求命中枚举集——逐块校验 ①板块为本人未翻面可卖 ②所卖向商人可达且
 * 图标匹配 ③啤酒（显式 beerSources 或自动解析）按顺序试消耗可行。
 * 模拟推进啤酒消耗(多组共享酒库存),全部通过才放行;任何一步非法抛
 * IllegalActionError('illegal-sell'/'insufficient-beer'/'illegal-beer-sources'…)。
 * 注:行动卡在手校验在 apply.ts 的 isLegalAction 一并做。
 */
export function validateSales(state: GameState, player: PlayerIndex, action: SellAction): void {
  if (action.sales.length === 0) {
    throw new IllegalActionError('illegal-sell', 'illegal-sell: empty sales');
  }
  let sim = state;
  let developBonusTriggers = 0;
  for (const sale of action.sales) {
    const placed = sim.board.slots[sale.location]?.[sale.slotIndex];
    if (
      placed === null ||
      placed === undefined ||
      placed.player !== player ||
      placed.flipped ||
      !placed.tile.sellable
    ) {
      throw new IllegalActionError(
        'illegal-sell',
        `illegal-sell: no sellable tile at ${sale.location} slot ${sale.slotIndex}`,
      );
    }
    if (!reachableFrom(sim, [sale.location]).has(sale.merchant)) {
      throw new IllegalActionError(
        'illegal-sell',
        `illegal-sell: merchant ${sale.merchant} is not reachable from ${sale.location}`,
      );
    }
    const m = sim.merchants[sale.merchant];
    if (!m.tiles.some((t) => t === 'any' || t === placed.tile.industry)) {
      throw new IllegalActionError(
        'illegal-sell',
        `illegal-sell: merchant ${sale.merchant} does not accept ${placed.tile.industry}`,
      );
    }
    // 啤酒试消耗(显式源按显式结算,否则自动解析),并推进模拟态(组间共享酒库存)
    const rb = consumeBeer(sim, player, placed.tile.beerToFlip, {
      at: sale.merchant,
      useMerchantBeer: sale.useMerchantBeer,
      industry: placed.tile.industry,
      ...(sale.beerSources !== undefined ? { explicit: sale.beerSources } : {}),
    });
    if (rb.merchantBonus && MERCHANTS[sale.merchant].bonus.type === 'develop') {
      developBonusTriggers += 1;
    }
    sim = rb.state;
  }
  // 显式研发选择(bonusDevelop):本笔卖货须真的触发 develop 类商人奖励,
  // 且所选产业栈顶板块存在且可研发(灯泡陶 developable:false 不可移除)
  if (action.bonusDevelop !== undefined) {
    if (developBonusTriggers === 0) {
      throw new IllegalActionError(
        'illegal-sell',
        'illegal-sell: bonusDevelop given but no develop-type merchant bonus triggered',
      );
    }
    const top = state.players[player]!.tiles.find((t) => t.industry === action.bonusDevelop);
    if (top === undefined || !top.developable) {
      throw new IllegalActionError(
        'illegal-sell',
        `illegal-sell: no developable top tile for ${action.bonusDevelop}`,
      );
    }
  }
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

/** 显式免费 develop(bonusDevelop):移除指定产业的栈顶板块(合法性已由 validateSales 保证)。 */
function settleFreeDevelopExplicit(state: GameState, player: PlayerIndex, ind: IndustryType): GameState {
  const ps: PlayerState = state.players[player]!;
  const idx = ps.tiles.findIndex((t) => t.industry === ind);
  const players = state.players.slice();
  players[player] = {
    ...ps,
    tiles: [...ps.tiles.slice(0, idx), ...ps.tiles.slice(idx + 1)],
  };
  return { ...state, players };
}

/**
 * 执行 Sell。先组合式校验（validateSales：任意合法组合均可,不限枚举集），
 * 再按 sales 顺序逐块结算：耗啤酒（显式 beerSources 按显式,否则自动解析;
 * 来源翻面事件在前）→ 商人奖励（vp/money/income 已由 consumeBeer 结算;
 * gloucester 在此免费 develop）→ 板块翻面进收入。
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
  validateSales(state, player, action);

  const events: GameEvent[] = [];
  let next = state;
  let bonusDevelopUsed = false;
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
      industry: placed.tile.industry,
      ...(sale.beerSources !== undefined ? { explicit: sale.beerSources } : {}),
    });
    next = rb.state;
    events.push(...rb.flipped);
    if (rb.merchantBonus) {
      events.push(rb.merchantBonus);
      if (MERCHANTS[sale.merchant].bonus.type === 'develop') {
        // 首个 develop 奖励优先用显式选择(bonusDevelop);其余/缺省按规范化
        if (action.bonusDevelop !== undefined && !bonusDevelopUsed) {
          next = settleFreeDevelopExplicit(next, player, action.bonusDevelop);
          bonusDevelopUsed = true;
        } else {
          next = settleFreeDevelop(next, player);
        }
      }
    }
    const f = applyFlip(next, sale.location, sale.slotIndex);
    next = f.state;
    events.push(f.event);
  }
  return { state: next, events };
}
