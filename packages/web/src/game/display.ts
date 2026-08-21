/**
 * 前端统一文案层（汉化单一来源）。
 *
 * 引擎数据里的英文名（LOCATIONS[].name、产业 key、MerchantId）仅供规则与 LLM 提示词使用；
 * web 一律经本模块取中文名。消除原先 Panels/interactions/ActionBar 三处重复映射。
 */
import type { Action, Card, IndustryType, LocationId, MerchantId } from '@brass/engine';
import { LOCATIONS } from '@brass/engine';

/** 城市/地点中文名（含 2 个农场酒厂）。 */
export const LOCATION_ZH: Record<string, string> = {
  belper: '贝尔珀',
  derby: '德比',
  leek: '利克',
  'stoke-on-trent': '斯托克',
  stone: '斯通',
  uttoxeter: '乌托克斯特',
  stafford: '斯塔福德',
  'burton-on-trent': '特伦特河畔伯顿',
  cannock: '坎诺克',
  tamworth: '塔姆沃思',
  walsall: '沃尔索尔',
  wolverhampton: '伍尔弗汉普顿',
  coalbrookdale: '科尔布鲁克代尔',
  dudley: '达德利',
  kidderminster: '基德明斯特',
  worcester: '伍斯特',
  birmingham: '伯明翰',
  coventry: '考文垂',
  nuneaton: '纳尼顿',
  redditch: '雷迪奇',
  'farm-north': '农场酒厂·北',
  'farm-south': '农场酒厂·南',
};

/** 商人位中文名。 */
export const MERCHANT_ZH: Record<MerchantId, string> = {
  shrewsbury: '什鲁斯伯里',
  gloucester: '格洛斯特',
  oxford: '牛津',
  warrington: '沃灵顿',
  nottingham: '诺丁汉',
};

/** 产业中文名。 */
export const INDUSTRY_ZH: Record<IndustryType, string> = {
  cotton: '棉纺厂',
  manufacturer: '制造厂',
  pottery: '陶器厂',
  coal: '煤矿',
  iron: '铁矿',
  brewery: '酿酒厂',
};

export function locationName(id: string): string {
  return LOCATION_ZH[id] ?? LOCATIONS[id as LocationId]?.name ?? id;
}

export function merchantName(id: string): string {
  return MERCHANT_ZH[id as MerchantId] ?? id;
}

export function industryName(ind: string): string {
  return INDUSTRY_ZH[ind as IndustryType] ?? ind;
}

/** 节点（城市或商人位）显示名。 */
export function nodeName(id: string): string {
  return LOCATION_ZH[id] ?? MERCHANT_ZH[id as MerchantId] ?? id;
}

/**
 * cardId → Card 还原（id 即牌面 key + 副本序号:`loc-x-1`/`ind-x-y-2`/`wild-location-0`）。
 * 行动记录里只有 cardId,画卡面/写牌名都要先还原。
 */
export function cardFromId(id: string): Card {
  if (id.startsWith('wild-location')) return { id, kind: 'wild-location' };
  if (id.startsWith('wild-industry')) return { id, kind: 'wild-industry' };
  if (id.startsWith('loc-')) {
    return { id, kind: 'location', location: id.slice(4, id.lastIndexOf('-')) as LocationId };
  }
  return { id, kind: 'industry', industries: id.slice(4, id.lastIndexOf('-')).split('-') as IndustryType[] };
}

/** 卡牌显示名（loc-x→城市中文名，ind-x→产业中文名，wild→百搭）。 */
export function cardName(card: { kind: string; location?: string; industries?: string[] }): string {
  switch (card.kind) {
    case 'location':
      return locationName(card.location ?? '');
    case 'industry':
      return (card.industries ?? []).map(industryName).join('/');
    case 'wild-location':
      return '百搭·城市';
    case 'wild-industry':
      return '百搭·产业';
    default:
      return card.kind;
  }
}

/** 卡牌面 key（素材文件名 loc-x / ind-x / wild-x，与 fetch-assets 输出一致）。 */
export function cardFaceKey(card: { kind: string; location?: string; industries?: string[] }): string {
  switch (card.kind) {
    case 'location':
      return `loc-${card.location}`;
    case 'industry':
      return `ind-${(card.industries ?? []).join('-')}`;
    case 'wild-location':
      return 'wild-location';
    case 'wild-industry':
      return 'wild-industry';
    default:
      return card.kind;
  }
}

/** 行动一句话描述（日志/确认条共用）。 */
export function describeAction(action: Action): string {
  switch (action.type) {
    case 'build':
      return `建造 ${locationName(action.location)}${industryName(action.industry)}`;
    case 'network':
      return `建设连接 ×${action.links.length}`;
    case 'develop':
      return `研发：移除 ${action.removals.map(industryName).join('、')}`;
    case 'sell':
      return `出售翻面 ×${action.sales.length}`;
    case 'loan':
      return '贷款 £30';
    case 'scout':
      return '侦察：弃 3 张换 2 张百搭';
    case 'pass':
      return '跳过';
  }
}
