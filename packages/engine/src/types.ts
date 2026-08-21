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
 * 显式啤酒来源（Sell 分组自选，2026-08-21）：逐桶指定。
 * - merchant：所卖向那个商人位的桶（至多 1 桶,用了发商人奖励,等价 useMerchantBeer）;
 * - brewery：指定槽位的酒厂桶——自己的酒厂无需连通,对手的酒厂须连通"用酒处"。
 */
export type BeerSourceRef =
  | { kind: 'merchant' }
  | { kind: 'brewery'; location: LocationId; slotIndex: number };

/**
 * 玩家行动。枚举函数（enumerateBuilds 等）只产出完全合法的行动；
 * applyAction 按 type 分派到各行动模块。
 */
export type Action =
  // slotIndex(可选):同地有多个合法空槽时玩家的显式选择(仅"无空单图标槽"时
  // 允许在空双图标槽间自选;单图标槽优先规则仍强制,见 applyBuild)。
  // 缺省 = 规范化解析(对手 overbuild → 单图标空槽 → 双图标空槽 → 己方 overbuild)。
  | { type: 'build'; cardId: string; industry: IndustryType; location: LocationId; slotIndex?: number }
  | { type: 'network'; cardId: string; links: number[]; beerFromOpponentBrewery?: LocationId } // links = LINKS 下标，len 1|2
  | { type: 'develop'; cardId: string; removals: IndustryType[] } // len 1|2
  // beerSources(可选):逐桶显式指定啤酒来源,长度须等于该板块 beerToFlip;
  // 缺省 = consumeBeer 自动解析(商人桶→自家酒厂→对手酒厂)。applySell 按组合式
  // 校验接受任意合法 sales 组合(不限于枚举集)。
  | { type: 'sell'; cardId: string; sales: { location: LocationId; slotIndex: number; merchant: MerchantId; useMerchantBeer: boolean; beerSources?: BeerSourceRef[] }[] }
  | { type: 'loan'; cardId: string }
  | { type: 'scout'; cardIds: [string, string, string] }
  | { type: 'pass'; cardId: string };
