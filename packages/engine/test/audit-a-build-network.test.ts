import { describe, expect, it } from 'vitest';
import { enumerateBuilds } from '../src/actions/build.js';
import { newGame, type GameState } from '../src/state.js';
import { LOCATIONS } from '../src/data/board.js';
import { tileDef } from '../src/data/tiles.js';
import type { Card } from '../src/data/cards.js';
import type { Action, IndustryType, LocationId, PlayerIndex } from '../src/types.js';

// 审计域：Build 行动 —— Industry 卡的 network 判定。
//
// 规则依据：
// - 规则书 p.8 "YOUR NETWORK"（rulebook.txt 行 868-876）：
//   "A location on the board is considered to be a part of your network if at least
//    one of the following is true: • The location contains one or more of your
//    Industry tiles; • The location is adjacent to one or more of your Link tiles."
//   —— 仅这两条。对手的 Link 只用于 "Connected Locations"（p.8 行 793-798，明确
//   "Link tiles owned by any player"，服务于煤/啤酒连通），不把途经地点纳入你的 network。
// - 规则书 p.9（行 962-968）：Industry 卡只能建在 "a location that is a part of
//   your network"。
// - rules-reference §6.1：「Industry 卡：在自己 network 内的地点建对应产业」。
//
// 引擎行为：build.ts 的 networkLocations（build.ts:171）用 isConnected 判定——
// 从 playerNetwork 出发沿"任何玩家"已建 Link 可达即算 network 内。对照
// actions/network.ts:69，铺路行动用的是严格的 playerNetwork（己方板块地点 +
// 己方 Link 端点），引擎内部两种语义不一致：Build 侧多枚举了非法行动。

const indCard = (industries: IndustryType[], id = `ind-${industries.join('-')}-audit`): Card => ({
  id,
  kind: 'industry',
  industries,
});

function setHand(s: GameState, player: PlayerIndex, cards: Card[]): void {
  s.players[player]!.hand = cards;
}

function withTile(s: GameState, player: PlayerIndex, loc: LocationId, industry: IndustryType): void {
  const def = tileDef(industry, 1)!;
  const slot = LOCATIONS[loc]!.slots.findIndex((sd) => sd.industries.includes(industry));
  s.board.slots[loc]![slot] = { tile: def, player, flipped: false, resources: def.resourcesPlaced };
}

/** 手工铺一条 Link（linkIndex 0 基）。 */
function withLink(s: GameState, linkIndex: number, player: PlayerIndex): void {
  s.board.links.push({ linkIndex, player, era: s.era });
}

const buildsAt = (acts: Action[], loc: LocationId) =>
  acts.filter((a): a is Extract<Action, { type: 'build' }> => a.type === 'build' && a.location === loc);

describe('audit: industry card network membership (rulebook p.8 YOUR NETWORK / p.9 Build)', () => {
  // 场景：玩家 0 在 birmingham 有自己的板块；对手（玩家 1）铺了 #9 birmingham–walsall。
  // 玩家 0 手牌为 Brewery 产业卡（酿酒 £5+1铁，铁无需连通，排除资源因素干扰）。
  // walsall 仅经"对手的 Link"可达：按规则不在玩家 0 的 network 内 → 不得枚举。
  it('RULE: location reachable only via an OPPONENT link is NOT in your network → build must not be enumerated', () => {
    const s = newGame(4, 5);
    withTile(s, 0, 'birmingham', 'cotton'); // 自己的板块 → birmingham 在 network 内
    withLink(s, 8, 1); // #9 birmingham–walsall，由对手铺设
    setHand(s, 0, [indCard(['brewery'])]);
    const acts = enumerateBuilds(s, 0);
    // 期望（规则）：walsall 不在玩家 0 的 network → 0 条
    // 实际（引擎 build.ts:171 isConnected 沿对手 Link 可达）→ 枚举出 brewery@walsall，本断言失败
    expect(buildsAt(acts, 'walsall').length).toBe(0);
  });

  it('control: same location reachable via your OWN link IS in your network → build enumerated', () => {
    const s = newGame(4, 5);
    withTile(s, 0, 'birmingham', 'cotton');
    withLink(s, 8, 0); // #9 birmingham–walsall，自己铺的
    setHand(s, 0, [indCard(['brewery'])]);
    // 自己 Link 的端点 walsall 在 network 内 → 合法（排除场景构造本身的干扰）
    expect(buildsAt(enumerateBuilds(s, 0), 'walsall').some((a) => a.industry === 'brewery')).toBe(true);
  });

  it('control: without any link the location is unreachable → not enumerated', () => {
    const s = newGame(4, 5);
    withTile(s, 0, 'birmingham', 'cotton');
    setHand(s, 0, [indCard(['brewery'])]);
    expect(buildsAt(enumerateBuilds(s, 0), 'walsall').length).toBe(0);
  });

  it('RULE: reachability chained through opponent links also grants no network membership (2-hop case)', () => {
    const s = newGame(4, 5);
    withTile(s, 0, 'birmingham', 'cotton');
    withLink(s, 8, 1); // #9 birmingham–walsall（对手）
    withLink(s, 38, 1); // #39 walsall–wolverhampton（对手）
    setHand(s, 0, [indCard(['coal'])]); // wolverhampton 有煤槽（[制造/煤]），煤 L1 £5 无资源成本
    const acts = enumerateBuilds(s, 0);
    // wolverhampton 距自己的板块隔两条对手 Link；规则上同样不在 network 内
    expect(buildsAt(acts, 'wolverhampton').length).toBe(0);
  });
});
