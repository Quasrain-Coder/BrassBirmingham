/**
 * NETWORK 评分。移植自 brass-assistant heuristic_ai/network.rs：
 * 新连通手牌激活、商人接通、枢纽 VP 潜力（link_vp_potential /
 * potential_link_vps）、过度铺路惩罚、运河末"关键路径"约束、
 * 铁路早酒厂农场锁定、双轨协同与真实煤成本估计。
 */
import {
  LINK_EXTRA_ENDPOINTS,
  LINKS,
  LOCATIONS,
  MERCHANTS,
  buyCoalCost,
  coalSources,
  firstLocationEndpoint,
  playerNetwork,
  type Action,
  type GameState,
  type IndustryType,
  type MerchantId,
  type NetworkNode,
  type PlayerIndex,
} from '@brass/engine';
import { vpEquivalent, type EvalContext } from './context.js';

const CANAL_LINK_COST = 3;
const RAIL_LINK_COST = 5;
const RAIL_DOUBLE_COST = 15;

function isMerchantNode(x: string): x is MerchantId {
  return Object.prototype.hasOwnProperty.call(MERCHANTS, x);
}

function linkEndpointsOf(linkIndex: number): NetworkNode[] {
  const l = LINKS[linkIndex]!;
  return [l.a, l.b, ...(LINK_EXTRA_ENDPOINTS[linkIndex] ?? [])];
}

/** 手里有能建 ind 的产业卡 / wild 产业卡。 */
function hasBuildableCard(
  state: GameState,
  pid: PlayerIndex,
  ind: IndustryType,
): boolean {
  return state.players[pid]!.hand.some(
    (c) =>
      (c.kind === 'industry' && c.industries.includes(ind)) ||
      c.kind === 'wild-industry',
  );
}

/** 新连通激活的手牌价值：地点卡进城 +0.6/张；产业卡 +0.1/张。 */
function handCardsNewlyInNetwork(
  state: GameState,
  pid: PlayerIndex,
  endpoints: NetworkNode[],
): number {
  const net = playerNetwork(state, pid);
  let count = 0;
  for (const card of state.players[pid]!.hand) {
    if (card.kind === 'location') {
      if (!net.has(card.location) && endpoints.includes(card.location)) {
        count += 0.6;
      }
    } else if (card.kind === 'industry') {
      count += 0.1;
    }
  }
  return count;
}

/** 枢纽 VP 潜力：两端城市空槽里自己还能建的最高 VP 板块（2 级+ ×1.4）。 */
function linkVpPotential(
  state: GameState,
  pid: PlayerIndex,
  endpoints: NetworkNode[],
): number {
  let total = 0;
  for (const e of endpoints) {
    if (isMerchantNode(e)) continue;
    const def = LOCATIONS[e];
    if (!def || def.region === 'farm') continue;
    const slots = state.board.slots[e]!;
    for (let i = 0; i < def.slots.length; i++) {
      if (slots[i] !== null && slots[i] !== undefined) continue;
      let best = 0;
      for (const ind of def.slots[i]!.industries) {
        const tile = state.players[pid]!.tiles.find(
          (t) => t.industry === ind,
        );
        if (!tile) continue;
        const v = tile.vp * (tile.level >= 2 ? 1.4 : 1.0);
        if (v > best) best = v;
      }
      total += best;
    }
  }
  return total;
}

/** 节点即时 Link 图标分：商人位 2；城市 = 已翻面板块 linkIcons 和；农场同。 */
function immediateLinkIconsAt(state: GameState, node: NetworkNode): number {
  if (isMerchantNode(node)) return 2;
  let v = 0;
  for (const t of state.board.slots[node] ?? []) {
    if (t && t.flipped) v += t.tile.linkIcons;
  }
  return v;
}

/** 节点未来潜力：空槽最佳可建板块的 linkIcons + 0.2×vp（+等级/手牌修正）。 */
function futureLinkNodePotential(
  state: GameState,
  pid: PlayerIndex,
  node: NetworkNode,
): number {
  if (isMerchantNode(node)) return 0;
  const def = LOCATIONS[node];
  if (!def || def.region === 'farm') return 0;
  const slots = state.board.slots[node]!;
  let total = 0;
  for (let i = 0; i < def.slots.length; i++) {
    if (slots[i] !== null && slots[i] !== undefined) continue;
    let best = 0;
    for (const ind of def.slots[i]!.industries) {
      const tile = state.players[pid]!.tiles.find((t) => t.industry === ind);
      if (!tile) continue;
      let v = tile.linkIcons + tile.vp * 0.2;
      if (tile.level >= 2 && state.era === 'canal') v += 0.6;
      if (hasBuildableCard(state, pid, ind)) v += 0.25;
      if (v > best) best = v;
    }
    total += best;
  }
  return total;
}

function potentialLinkVps(
  state: GameState,
  pid: PlayerIndex,
  endpoints: NetworkNode[],
): number {
  let immediate = 0;
  let future = 0;
  for (const e of endpoints) {
    immediate += immediateLinkIconsAt(state, e);
    future += futureLinkNodePotential(state, pid, e);
  }
  return immediate + 0.7 * future;
}

/** 该铁路的煤成本估计：连通免费矿 → 0；否则市价 1 块（市场空时即兜底价 £8）。 */
function estimatedLinkCoalCost(state: GameState, linkIndex: number): number {
  const at = firstLocationEndpoint(linkIndex);
  const free = coalSources(state, 0, at).reduce(
    (s, x) => s + x.tile.resources,
    0,
  );
  return free >= 1 ? 0 : buyCoalCost(state, 1);
}

/** 单条连接的评分（score_network_candidate）。 */
function scoreSingleLink(
  state: GameState,
  pid: PlayerIndex,
  linkIndex: number,
  cost: number,
  ctx: EvalContext,
): number {
  const endpoints = linkEndpointsOf(linkIndex);
  const accessGain = handCardsNewlyInNetwork(state, pid, endpoints);
  const merchantGain = endpoints.some((e) => isMerchantNode(e)) ? 1.5 : 0;

  // 铁路时代"通路乘数"：打进密集工业枢纽是最高价值玩法。
  const vpPotential = linkVpPotential(state, pid, endpoints);
  const potentialVps = potentialLinkVps(state, pid, endpoints);
  const hubBonus =
    state.era === 'rail'
      ? vpPotential * 0.12 + potentialVps * 0.6
      : vpPotential * 0.04 + potentialVps * 0.1;

  const linksBuilt = state.board.links.filter(
    (l) => l.player === pid && l.era === state.era,
  ).length;
  // 过度铺路惩罚：连接的价值取决于它连接的板块；没有产能却狂铺是死局来源。
  let productive = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) if (t && t.player === pid) productive += 1;
  }
  const overNetworkingPenalty =
    productive <= 0
      ? Math.max(0, linksBuilt - 1) * 1.2
      : Math.max(0, linksBuilt - 2 * productive - 1) * 0.2;
  const explorationBonus = Math.max(0, 1.6 - linksBuilt * 0.3);

  // 计划（流派）加成：触及"计划产业仍有空槽"的城市 = 打开产能。
  let planBonus = 0;
  if (
    ctx.plan.count > 0 &&
    ctx.profile.phase !== 'canal-early' &&
    state.players[pid]!.tiles.some((t) => t.industry === ctx.plan.industry)
  ) {
    for (const e of endpoints) {
      if (isMerchantNode(e)) continue;
      const def = LOCATIONS[e];
      if (!def || def.region === 'farm') continue;
      const slots = state.board.slots[e]!;
      const ok = def.slots.some(
        (s, i) =>
          s.industries.includes(ctx.plan.industry) &&
          (slots[i] === null || slots[i] === undefined),
      );
      if (ok) {
        planBonus = 0.5;
        break;
      }
    }
  }

  // 运河末"关键路径"：既不开产能也不接商人/农场的死路是纯现金坑。
  let criticalPenalty = 0;
  if (ctx.profile.phase === 'canal-late') {
    let useful = false;
    for (const e of endpoints) {
      if (isMerchantNode(e)) {
        useful = true;
        break;
      }
      const def = LOCATIONS[e];
      if (!def) continue;
      if (def.region === 'farm') {
        useful = true;
        break;
      }
      const slots = state.board.slots[e]!;
      for (let i = 0; i < def.slots.length && !useful; i++) {
        if (slots[i] !== null && slots[i] !== undefined) continue;
        for (const ind of def.slots[i]!.industries) {
          if (state.players[pid]!.tiles.some((t) => t.industry === ind)) {
            useful = true;
            break;
          }
        }
      }
      if (useful) break;
    }
    if (!useful) criticalPenalty = 2.5;
  }

  // 铁路早"酒厂农场锁定"：农场边锁定啤酒供应（双轨与收官卖货都靠它）。
  const beerLockBonus =
    ctx.profile.phase === 'rail-early' &&
    endpoints.some((e) => !isMerchantNode(e) && LOCATIONS[e]?.region === 'farm')
      ? 1.2
      : 0;

  let score =
    vpEquivalent(ctx.profile, accessGain + merchantGain, 0, -cost, 0) +
    explorationBonus -
    overNetworkingPenalty +
    planBonus -
    criticalPenalty +
    beerLockBonus;
  score += hubBonus * ctx.profile.networkW;
  return score;
}

/** network 行动评分（单条/双条统一；对应 score_top_networks(+doubles)）。 */
export function scoreNetwork(
  state: GameState,
  pid: PlayerIndex,
  action: Extract<Action, { type: 'network' }>,
  ctx: EvalContext,
): number {
  const links = action.links;
  if (links.length === 0) return Number.NEGATIVE_INFINITY;

  if (state.era === 'canal') {
    const score = scoreSingleLink(state, pid, links[0]!, CANAL_LINK_COST, ctx);
    return score;
  }

  if (links.length === 1) {
    const cost = RAIL_LINK_COST + estimatedLinkCoalCost(state, links[0]!);
    return scoreSingleLink(state, pid, links[0]!, cost, ctx);
  }

  // 双轨：£15 + 每条 1 煤 + 1 酒；两单条分和 − 贵出的基价 + 节奏协同。
  const [i1, i2] = [links[0]!, links[1]!];
  const cost1 = RAIL_LINK_COST + estimatedLinkCoalCost(state, i1);
  const cost2 = RAIL_LINK_COST + estimatedLinkCoalCost(state, i2);
  const s1 = scoreSingleLink(state, pid, i1, cost1, ctx);
  const s2 = scoreSingleLink(state, pid, i2, cost2, ctx);
  const extraBase = RAIL_DOUBLE_COST - 2 * RAIL_LINK_COST;
  let score = s1 + s2 - extraBase * ctx.profile.moneyW;
  // 一动建两条 = 节奏赢一手；铁路早期铺网快，协同更高。
  score += ctx.profile.phase === 'rail-early' ? 1.2 : 0.6;
  // 触及农场的双轨 = 锁啤酒 + 省节奏，尤值。
  const touchesFarm = [i1, i2].some((i) =>
    linkEndpointsOf(i).some(
      (e) => !isMerchantNode(e) && LOCATIONS[e]?.region === 'farm',
    ),
  );
  if (touchesFarm) score += 0.8;
  return score;
}
