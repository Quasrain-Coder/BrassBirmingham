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
