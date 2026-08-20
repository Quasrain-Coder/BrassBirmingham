/**
 * GameState 核心类型与对局初始化（rules-reference §4 初始设置 + §8 人数变体）。
 *
 * 初始化顺序（确定性，同一 seed 逐字节一致）：
 * 1. 建牌堆并洗牌，发 8 张/人，再抽 1 张作弃牌堆底；
 * 2. 按人数取商人板块洗混，铺到可用商人位（MERCHANTS 键序），每非 blank 板块 beer=1；
 * 3. 角色块洗混定首轮顺位。
 */
import type {
  Era,
  GameEvent,
  LocationId,
  MerchantId,
  PlayerIndex,
} from './types.js';
import { LOCATIONS, MERCHANTS } from './data/board.js';
import { TILES, type TileDef } from './data/tiles.js';
import {
  buildDeck,
  WILD_INDUSTRY_COUNT,
  WILD_LOCATION_COUNT,
  type Card,
} from './data/cards.js';
import {
  COAL_MARKET_INITIAL_FILLED,
  IRON_MARKET_INITIAL_FILLED,
} from './data/market.js';
import { INCOME_START_SPACE } from './data/income.js';
import { createRng } from './rng.js';

export interface PlacedTile {
  tile: TileDef;
  player: PlayerIndex;
  flipped: boolean;
  /** 煤/铁方块数或啤酒桶数（酒厂桶数按时代，见 market.ts BREWERY_BARRELS）。 */
  resources: number;
}

export interface BuiltLink {
  linkIndex: number;
  player: PlayerIndex;
  /** 建造时所在时代（运河时代的连接画驳船、铁路时代画火车）。 */
  era: Era;
}

export interface PlayerState {
  /** wild 卡也是 hand 里的 Card（kind: 'wild-location'|'wild-industry'）。 */
  hand: Card[];
  /** 面板堆叠（未建），按产业分组、等级升序，建造即取栈顶。 */
  tiles: TileDef[];
  money: number;
  incomeSpace: number;
  vp: number;
  spentThisRound: number;
}

export type MerchantTile = 'any' | 'cotton' | 'manufacturer' | 'pottery' | 'blank';

export interface GameState {
  playerCount: 2 | 3 | 4;
  era: Era;
  /** 从 1 起。 */
  round: number;
  board: {
    slots: Record<LocationId, (PlacedTile | null)[]>;
    links: BuiltLink[];
  };
  merchants: Record<MerchantId, { tiles: MerchantTile[]; beer: number }>;
  /** Wild 卡供应堆余量（§6.7 Scout 获取、Wild 弃置归还；§9.14）。 */
  wildSupply: { location: number; industry: number };
  /** 已填充方块数（索引语义见 market.ts helper）。 */
  coalMarket: number;
  ironMarket: number;
  deck: Card[];
  discard: Card[];
  players: PlayerState[];
  /** 本轮顺位。 */
  turnOrder: PlayerIndex[];
  /** turnOrder 内下标。 */
  currentPlayerIdx: number;
  /** 当前玩家本轮已行动数。 */
  actionsThisTurn: number;
  /** 每步快照，供重放校验。 */
  rngState: number;
  /** 上一步 applyX/applyAction 产生的事件。 */
  lastEvents: GameEvent[];
  /** 时代结束待清算（牌堆空且全部手牌空的轮末由 turn.ts 置位；Task 12 消费做时代切换/终局）。 */
  eraEndPending: boolean;
  phase: 'action' | 'game-over';
  winner: PlayerIndex[] | null;
}

const START_MONEY = 17;
const HAND_SIZE = 8;

/** 商人板块构成（§1.4）：2p 基础 5 块；3p +{pottery, blank}；4p +{cotton, manufacturer}。 */
function merchantTilePool(playerCount: 2 | 3 | 4): MerchantTile[] {
  const pool: MerchantTile[] = ['any', 'cotton', 'manufacturer', 'blank', 'blank'];
  if (playerCount >= 3) pool.push('pottery', 'blank');
  if (playerCount >= 4) pool.push('cotton', 'manufacturer');
  return pool;
}

/** 可用商人位（§8）：2p 不放 warrington/nottingham；3p 不放 nottingham。 */
function availableMerchants(playerCount: 2 | 3 | 4): MerchantId[] {
  const all = Object.keys(MERCHANTS) as MerchantId[];
  return all.filter((id) => {
    if (playerCount === 2) return id !== 'warrington' && id !== 'nottingham';
    if (playerCount === 3) return id !== 'nottingham';
    return true;
  });
}

/** 玩家面板：TILES 按 count 展开（TILES 本身按产业分组、等级升序）。 */
function playerTileStacks(): TileDef[] {
  const out: TileDef[] = [];
  for (const def of TILES) {
    for (let i = 0; i < def.count; i++) out.push(def);
  }
  return out;
}

export function newGame(playerCount: 2 | 3 | 4, seed: number): GameState {
  const rng = createRng(seed);

  // 1. 牌堆：洗牌 → 发 8 张/人 → 1 张弃牌堆底
  const shuffled = rng.shuffle(buildDeck(playerCount));
  let cursor = 0;
  const hands: Card[][] = [];
  for (let i = 0; i < playerCount; i++) {
    hands.push(shuffled.slice(cursor, cursor + HAND_SIZE));
    cursor += HAND_SIZE;
  }
  const discard = shuffled.slice(cursor, cursor + 1);
  cursor += 1;
  const deck = shuffled.slice(cursor);

  // 2. 商人板块：洗混后按 MERCHANTS 键序铺位；每非 blank 板块 beer=1
  const tiles = rng.shuffle(merchantTilePool(playerCount));
  const available = new Set(availableMerchants(playerCount));
  const merchants = {} as Record<MerchantId, { tiles: MerchantTile[]; beer: number }>;
  let t = 0;
  for (const id of Object.keys(MERCHANTS) as MerchantId[]) {
    if (!available.has(id)) {
      merchants[id] = { tiles: [], beer: 0 };
      continue;
    }
    const placed = tiles.slice(t, t + MERCHANTS[id].slots);
    t += MERCHANTS[id].slots;
    merchants[id] = {
      tiles: placed,
      beer: placed.filter((x) => x !== 'blank').length,
    };
  }

  // 3. 角色块洗混定首轮顺位
  const turnOrder = rng.shuffle(
    Array.from({ length: playerCount }, (_, i) => i as PlayerIndex),
  );

  const slots: Record<LocationId, (PlacedTile | null)[]> = {};
  for (const [id, loc] of Object.entries(LOCATIONS)) {
    slots[id] = Array.from({ length: loc.slots.length }, () => null);
  }

  const players: PlayerState[] = hands.map((hand) => ({
    hand,
    tiles: playerTileStacks(),
    money: START_MONEY,
    incomeSpace: INCOME_START_SPACE,
    vp: 0,
    spentThisRound: 0,
  }));

  return {
    playerCount,
    era: 'canal',
    round: 1,
    board: { slots, links: [] },
    merchants,
    wildSupply: { location: WILD_LOCATION_COUNT, industry: WILD_INDUSTRY_COUNT },
    coalMarket: COAL_MARKET_INITIAL_FILLED,
    ironMarket: IRON_MARKET_INITIAL_FILLED,
    deck,
    discard,
    players,
    turnOrder,
    currentPlayerIdx: 0,
    actionsThisTurn: 0,
    rngState: rng.getState(),
    lastEvents: [],
    eraEndPending: false,
    phase: 'action',
    winner: null,
  };
}
