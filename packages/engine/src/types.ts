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
