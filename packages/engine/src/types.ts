/** 共享基础类型。引擎纯数据与状态描述均使用这些类型。 */

export type IndustryType = 'cotton' | 'manufacturer' | 'pottery' | 'coal' | 'iron' | 'brewery';
export type Era = 'canal' | 'rail';
export type PlayerIndex = number;
export type MerchantId = 'shrewsbury' | 'gloucester' | 'oxford' | 'warrington' | 'nottingham';
/** 20 个 named location 的 kebab-case id + 'farm-north' + 'farm-south'。 */
export type LocationId = string;

/** 一个产业槽位，印 1 或 2 个产业图标。 */
export interface IndustrySlot {
  industries: IndustryType[];
}

/** 一条连接边。canal/rail 分别表示该边在运河/铁路时代可建。 */
export interface Link {
  a: LocationId | MerchantId;
  b: LocationId | MerchantId;
  canal: boolean;
  rail: boolean;
}

/** 板块翻面事件（Sell 翻面或资源耗尽翻面）。 */
export interface FlipEvent {
  kind: 'flip';
  player: PlayerIndex;
  location: LocationId;
  incomeAdvance: number;
}

/** 商人奖励事件（Sell 时消耗了所卖向商人板块旁的啤酒）。 */
export interface MerchantBonusEvent {
  kind: 'merchant-bonus';
  player: PlayerIndex;
  merchant: MerchantId;
}

/** applyAction 产生的事件；写入 GameState.lastEvents。 */
export type GameEvent = FlipEvent | MerchantBonusEvent;

/**
 * 玩家行动。枚举函数（enumerateBuilds 等）只产出完全合法的行动；
 * applyAction 按 type 分派到各行动模块。
 */
export type Action =
  | { type: 'build'; cardId: string; industry: IndustryType; location: LocationId }
  | { type: 'network'; cardId: string; links: number[]; beerFromOpponentBrewery?: LocationId } // links = LINKS 下标，len 1|2
  | { type: 'develop'; cardId: string; removals: IndustryType[] } // len 1|2
  | { type: 'sell'; cardId: string; sales: { location: LocationId; slotIndex: number; merchant: MerchantId; useMerchantBeer: boolean }[] }
  | { type: 'loan'; cardId: string }
  | { type: 'scout'; cardIds: [string, string, string] }
  | { type: 'pass'; cardId: string };
