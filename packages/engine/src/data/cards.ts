/**
 * 牌组构成（2/3/4 人：40/54/64 张 + 各 4 张 Wild）。
 * 逐卡明细转录自 docs/rules-reference.md §3（[N] 单一来源；总量 40/54/64 经 [T] 确认）。
 *
 * 实现方式：以 4 人 64 张全量表为基准，每张卡标 `minPlayers`（卡面右下角人数图标），
 * buildDeck(n) 取 minPlayers <= n 的子集：
 * - 3p 移除：Belper×2、Derby×3、Uttoxeter×1、Coal×1、Pottery×1、双图标×2 → 54 张
 * - 2p 再移除：Leek×2、Stoke×3、Stone×2、Uttoxeter×1、双图标×6 → 40 张
 *
 * Wild 卡不进牌堆（独立供应堆，Scout 行动获得），此处仅导出数量常量。
 */
import type { IndustryType, LocationId } from '../types.js';

export type CardFace =
  | { kind: 'location'; location: LocationId }
  | { kind: 'industry'; industries: IndustryType[] }
  | { kind: 'wild-location' }
  | { kind: 'wild-industry' };

export type Card = { id: string } & CardFace;

export const WILD_LOCATION_COUNT = 4;
export const WILD_INDUSTRY_COUNT = 4;

interface CardSpec {
  /** 卡面人数图标：仅当本局人数 >= minPlayers 时入牌堆。 */
  minPlayers: 2 | 3 | 4;
  count: number;
  card: CardFace;
}

const loc = (location: LocationId): CardFace => ({ kind: 'location', location });
const ind = (...industries: IndustryType[]): CardFace => ({ kind: 'industry', industries });

const CARD_SPECS: CardSpec[] = [
  // ---- Location 卡 41 张（4p）----
  { minPlayers: 2, count: 3, card: loc('birmingham') },
  { minPlayers: 2, count: 3, card: loc('coventry') },
  { minPlayers: 2, count: 3, card: loc('coalbrookdale') },
  { minPlayers: 4, count: 3, card: loc('derby') },
  { minPlayers: 3, count: 3, card: loc('stoke-on-trent') },
  { minPlayers: 4, count: 2, card: loc('belper') },
  { minPlayers: 3, count: 2, card: loc('leek') },
  { minPlayers: 3, count: 2, card: loc('stone') },
  // Uttoxeter 两张其一为 4p 专用，另一张 3p 专用（2p 全移除）。
  { minPlayers: 4, count: 1, card: loc('uttoxeter') },
  { minPlayers: 3, count: 1, card: loc('uttoxeter') },
  { minPlayers: 2, count: 2, card: loc('stafford') },
  { minPlayers: 2, count: 2, card: loc('burton-on-trent') },
  { minPlayers: 2, count: 2, card: loc('cannock') },
  { minPlayers: 2, count: 2, card: loc('dudley') },
  { minPlayers: 2, count: 2, card: loc('kidderminster') },
  { minPlayers: 2, count: 2, card: loc('wolverhampton') },
  { minPlayers: 2, count: 2, card: loc('worcester') },
  { minPlayers: 2, count: 1, card: loc('tamworth') },
  { minPlayers: 2, count: 1, card: loc('walsall') },
  { minPlayers: 2, count: 1, card: loc('nuneaton') },
  { minPlayers: 2, count: 1, card: loc('redditch') },
  // ---- Industry 卡 15 张（4p）----
  { minPlayers: 2, count: 4, card: ind('iron') },
  { minPlayers: 4, count: 1, card: ind('coal') },
  { minPlayers: 2, count: 2, card: ind('coal') },
  { minPlayers: 4, count: 1, card: ind('pottery') },
  { minPlayers: 2, count: 2, card: ind('pottery') },
  { minPlayers: 2, count: 5, card: ind('brewery') },
  // ---- 双图标产业卡（棉/制造二选一）8 张：4p 8、3p 6、2p 0 ----
  { minPlayers: 4, count: 2, card: ind('cotton', 'manufacturer') },
  { minPlayers: 3, count: 6, card: ind('cotton', 'manufacturer') },
];

function faceId(card: CardFace): string {
  switch (card.kind) {
    case 'location':
      return `loc-${card.location}`;
    case 'industry':
      return `ind-${card.industries.join('-')}`;
    case 'wild-location':
      return 'wild-location';
    case 'wild-industry':
      return 'wild-industry';
  }
}

/** 生成指定人数的抽牌堆（不含 Wild；Wild 为独立供应堆）。 */
export function buildDeck(playerCount: 2 | 3 | 4): Card[] {
  const deck: Card[] = [];
  const counters = new Map<string, number>();
  for (const spec of CARD_SPECS) {
    if (spec.minPlayers > playerCount) continue;
    const base = faceId(spec.card);
    for (let i = 0; i < spec.count; i++) {
      const n = counters.get(base) ?? 0;
      counters.set(base, n + 1);
      deck.push({ ...spec.card, id: `${base}-${n}` });
    }
  }
  return deck;
}
