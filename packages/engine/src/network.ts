/**
 * 网络连通计算（rules-reference §6.1 / §9.1–9.2）。
 *
 * 概念分两层：
 * - **playerNetwork**：玩家"自己"的网络——有其板块（无论翻面与否）的地点 +
 *   其 Link 的全部端点（含商人位与三端点边的农场端点）。用于建造/铺路邻接判定。
 * - **资源连通**（isConnected/coalSources）：从玩家网络（或建造地点）出发，
 *   沿"当前时代可用的所有已建 Link"（任何玩家铺的都算）遍历可达即连通。
 *   canBuyCoalFromMarket 的锚点是建造地点而非玩家 network（§5/§9.2）。
 *
 * 注意（§9.2）：商人位连通不要求该位放有商人板块——2p 局的 warrington/nottingham
 * 照样是市场连通点。铁完全不需要连通（§9.1，见 ironSources）。
 */
import { LINK_EXTRA_ENDPOINTS, LINKS, MERCHANTS } from './data/board.js';
import type { GameState, PlacedTile } from './state.js';
import type { LocationId, MerchantId, PlayerIndex } from './types.js';

export type NetworkNode = LocationId | MerchantId;

const MERCHANT_IDS = Object.keys(MERCHANTS) as MerchantId[];

/** 一条 Link 的全部端点（含 LINK_EXTRA_ENDPOINTS 的农场端点）。 */
function linkEndpoints(linkIndex: number): NetworkNode[] {
  const l = LINKS[linkIndex]!;
  return [l.a, l.b, ...(LINK_EXTRA_ENDPOINTS[linkIndex] ?? [])];
}

/** 当前时代可用的已建边（所有玩家）的邻接表。 */
function builtAdjacency(state: GameState): Map<NetworkNode, NetworkNode[]> {
  const adj = new Map<NetworkNode, NetworkNode[]>();
  const add = (x: NetworkNode, y: NetworkNode): void => {
    const list = adj.get(x);
    if (list) list.push(y);
    else adj.set(x, [y]);
  };
  for (const bl of state.board.links) {
    const l = LINKS[bl.linkIndex]!;
    if (state.era === 'canal' ? !l.canal : !l.rail) continue;
    const eps = linkEndpoints(bl.linkIndex);
    for (const x of eps) {
      for (const y of eps) {
        if (x !== y) add(x, y);
      }
    }
  }
  return adj;
}

/** 从种子节点集沿已建边 DFS 的可达集（含种子自身）。 */
function reachableFrom(state: GameState, seeds: Iterable<NetworkNode>): Set<NetworkNode> {
  const adj = builtAdjacency(state);
  const seen = new Set<NetworkNode>(seeds);
  const queue = [...seen];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const nb of adj.get(cur) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  return seen;
}

/** 从 from 节点沿已建边 BFS 的距离表（from 自身距离 0）。 */
function bfsDistances(state: GameState, from: NetworkNode): Map<NetworkNode, number> {
  const adj = builtAdjacency(state);
  const dist = new Map<NetworkNode, number>([[from, 0]]);
  let frontier: NetworkNode[] = [from];
  let d = 0;
  while (frontier.length > 0) {
    d += 1;
    const next: NetworkNode[] = [];
    for (const cur of frontier) {
      for (const nb of adj.get(cur) ?? []) {
        if (!dist.has(nb)) {
          dist.set(nb, d);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

/** 玩家 network 覆盖的节点：有其板块的地点 + 其 Link 两端点（含商人位）。 */
export function playerNetwork(state: GameState, player: PlayerIndex): Set<NetworkNode> {
  const net = new Set<NetworkNode>();
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    if (slots.some((t) => t !== null && t.player === player)) net.add(loc);
  }
  for (const bl of state.board.links) {
    if (bl.player !== player) continue;
    for (const e of linkEndpoints(bl.linkIndex)) net.add(e);
  }
  return net;
}

/** target 是否从玩家网络沿已建边（任何玩家）可达。 */
export function isConnected(
  state: GameState,
  player: PlayerIndex,
  target: NetworkNode,
): boolean {
  return reachableFrom(state, playerNetwork(state, player)).has(target);
}

/** network 可达的商人位（按 id 字典序，确定性）。不要求该位放有商人板块（§9.2）。 */
export function connectedMerchants(state: GameState, player: PlayerIndex): MerchantId[] {
  const reach = reachableFrom(state, playerNetwork(state, player));
  return MERCHANT_IDS.filter((id) => reach.has(id)).sort();
}

/**
 * 建造地点 at 是否连通任一商人位图标（§5/§9.2）——市场买煤的前提。
 * 锚点是"建造地点"而非玩家 network：沿已建边（任何玩家的）从 at 可达商人位即可，
 * 与 playerNetwork 无关（Location 卡可建在无 network 处；首建特例 network 为空）。
 * 不要求该位放有商人板块。买铁不需要连通（§9.1）。
 */
export function canBuyCoalFromMarket(state: GameState, at: LocationId): boolean {
  const reach = reachableFrom(state, [at]);
  return MERCHANT_IDS.some((id) => reach.has(id));
}

/**
 * 建造地点 at 连通的未翻面、未耗尽煤矿（任何玩家的均可免费取，§6.1）。
 * 按"距离最近"排序（沿已建边 BFS，at 自身的矿距离 0）；耗尽/翻面即跳过取次近者。
 * 距离并列按 LocationId 字典序（确定性规范化）。
 *
 * 注：煤源连通只与 at 和已建边有关，与 player 无关；保留 player 参数供后续
 * 行动层接口对称使用。
 */
export function coalSources(
  state: GameState,
  player: PlayerIndex,
  at: LocationId,
): { tile: PlacedTile; location: LocationId }[] {
  void player;
  const dist = bfsDistances(state, at);
  const out: { tile: PlacedTile; location: LocationId; slot: number }[] = [];
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    if (!dist.has(loc)) continue;
    for (let i = 0; i < slots.length; i++) {
      const t = slots[i]!;
      if (t && !t.flipped && t.tile.industry === 'coal' && t.resources > 0) {
        out.push({ tile: t, location: loc, slot: i });
      }
    }
  }
  out.sort(
    (a, b) =>
      dist.get(a.location)! - dist.get(b.location)! ||
      (a.location < b.location ? -1 : a.location > b.location ? 1 : 0) ||
      a.slot - b.slot,
  );
  return out.map(({ tile, location }) => ({ tile, location }));
}

/**
 * 全图未翻面、未耗尽铁厂（按 LocationId 字典序 + 槽位序，确定性）。
 * 铁不需要任何连通（§9.1）：任意铁厂可取、可混源。
 */
export function ironSources(state: GameState): { tile: PlacedTile; location: LocationId }[] {
  const out: { tile: PlacedTile; location: LocationId; slot: number }[] = [];
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (let i = 0; i < slots.length; i++) {
      const t = slots[i]!;
      if (t && !t.flipped && t.tile.industry === 'iron' && t.resources > 0) {
        out.push({ tile: t, location: loc, slot: i });
      }
    }
  }
  out.sort(
    (a, b) =>
      (a.location < b.location ? -1 : a.location > b.location ? 1 : 0) || a.slot - b.slot,
  );
  return out.map(({ tile, location }) => ({ tile, location }));
}
