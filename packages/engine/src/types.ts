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
 *   tileIndex(可选,2026-08-26)：指定商人位内第几格板块旁的桶（同商人格多收
 *   该产业且有多个桶时桶位是玩家自由选择）；缺省 = 规范化（精确图标格优先,其次万能格）。
 * - brewery：指定槽位的酒厂桶——自己的酒厂无需连通,对手的酒厂须连通"用酒处"。
 */
export type BeerSourceRef =
  | { kind: 'merchant'; tileIndex?: number }
  | { kind: 'brewery'; location: LocationId; slotIndex: number };

/**
 * 显式煤/铁来源（2026-08-26）：并列任选的资源取用是玩家自由选择
 * （规则书"最近的连通煤矿,并列任选"；铁"任意铁厂,可混源"）。
 * 逐源指定 {地点, 槽位, 取用量}；取用量合计不足需求时余量从市场买
 * （煤仍需连通商人位）。缺省 = 规范化（煤:距离最近+字典序;铁:字典序首个足够者）。
 */
export interface ResourceSourceRef {
  location: LocationId;
  slotIndex: number;
  count: number;
}

/**
 * 玩家行动。枚举函数（enumerateBuilds 等）只产出完全合法的行动；
 * applyAction 按 type 分派到各行动模块。
 */
export type Action =
  // slotIndex(可选):同地有多个合法空槽时玩家的显式选择(仅"无空单图标槽"时
  // 允许在空双图标槽间自选;单图标槽优先规则仍强制,见 applyBuild)。
  // coalSources/ironSources(可选):显式资源来源(并列任选的自由选择,见 types.ts
  // ResourceSourceRef);缺省 = 规范化解析。
  // 缺省 = 规范化解析(对手 overbuild → 单图标空槽 → 双图标空槽 → 己方 overbuild)。
  | { type: 'build'; cardId: string; industry: IndustryType; location: LocationId; slotIndex?: number; coalSources?: ResourceSourceRef[]; ironSources?: ResourceSourceRef[] }
  // coalSources(可选):逐条铁路的显式煤源(下标与 links 对齐;每项 1 块煤;
  // 缺省/null = 规范化解析含市场买)。
  | { type: 'network'; cardId: string; links: number[]; beerFromOpponentBrewery?: LocationId; beerSource?: { location: LocationId; slotIndex: number }; coalSources?: ({ location: LocationId; slotIndex: number } | null)[] } // links = LINKS 下标，len 1|2
  // ironSources(可选):逐块研发的显式铁源(并列任选的自由选择,同 build);
  // 缺省 = 规范化解析(单厂足够取字典序首个,否则按序混源,不足市场买)。
  | { type: 'develop'; cardId: string; removals: IndustryType[]; ironSources?: ResourceSourceRef[] } // len 1|2
  // beerSources(可选):逐桶显式指定啤酒来源,长度须等于该板块 beerToFlip;
  // 缺省 = consumeBeer 自动解析(商人桶→自家酒厂→对手酒厂)。applySell 按组合式
  // 校验接受任意合法 sales 组合(不限于枚举集)。
  // bonusDevelop:卖货触发 develop 类商人奖励(格洛斯特)时的显式研发产业——
  // 移除该产业栈顶可研发板块;缺省按产业序规范化移除(见 sell.ts settleFreeDevelop)。
  | { type: 'sell'; cardId: string; sales: { location: LocationId; slotIndex: number; merchant: MerchantId; useMerchantBeer: boolean; beerSources?: BeerSourceRef[] }[]; bonusDevelop?: IndustryType }
  | { type: 'loan'; cardId: string }
  | { type: 'scout'; cardIds: [string, string, string] }
  | { type: 'pass'; cardId: string };
