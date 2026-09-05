/**
 * 局势摘要器（GameState → 紧凑中文文本 prompt）。
 *
 * **prompt 卫生不变式：nickname / 聊天 / 日志文本永不进 prompt。** 本模块只读
 * GameState（纯数据）与 @brass/engine 的常量表/helper，不接收、不拼接任何外部
 * 文本——输出 = 固定中文模板 + 引擎 id/数字，UI 层字符串（玩家昵称、聊天记录、
 * 历史日志）不可能经由本模块泄漏进 LLM prompt。
 *
 * - summarizeState：紧凑结构化中文局势摘要（目标 < 1200 token）：时代/轮次/行动
 *   计数、viewer 现金/收入等级/VP/手牌（逐张）、各人场上板块（地点+产业+等级+
 *   翻面态+资源数）与 Link、煤铁市场（存量+下一块价格）、啤酒分布（自己酒厂/
 *   对手连通酒厂/商人桶）、甲板余量。对手手牌不展示（隐藏信息）。
 * - describeAction：行动的一句话中文描述，带决策关键信息——成本（£/煤/铁及
 *   免费来源或市购价）、连通（新连通地点/商人位）、翻面收益（VP/收入/Link）、
 *   啤酒来源（商人桶奖励/酒厂桶）。LLM 靠它做选择，信息不足会导致乱选。
 * - buildDecisionPrompt：system 完全静态（规则要点+角色+输出格式说明，两局不同
 *   seed 逐字节相同，缓存友好）；user = 局势摘要 + 0-based 编号候选列表（编号与
 *   choiceIndex 对齐）。
 *
 * 规则数值一律走 @brass/engine 的 market/network/income helpers，本包不重复实现。
 */
import {
  BREWERY_BARRELS,
  COAL_MARKET_PRICES,
  IRON_MARKET_PRICES,
  LINKS,
  LINK_EXTRA_ENDPOINTS,
  LOCATIONS,
  MERCHANTS,
  actionsPerRound,
  buyCoalCost,
  buyIronCost,
  canBuyCoalFromMarket,
  coalSources,
  incomeLevelAt,
  ironSources,
  loanBacktrack,
  marketSellRevenue,
  playerNetwork,
  reachableFrom,
  type Action,
  type GameState,
  type IndustryType,
  type LocationId,
  type MerchantId,
  type PlayerIndex,
} from '@brass/engine';

/** 产业中文名。 */
const INDUSTRY_CN: Record<IndustryType, string> = {
  cotton: '棉纺厂',
  manufacturer: '制造厂',
  pottery: '陶瓷厂',
  coal: '煤矿',
  iron: '铁厂',
  brewery: '酿酒厂',
};

/** 商人板块图标中文名（blank 不展示）。 */
const MERCHANT_TILE_CN: Record<string, string> = {
  any: '任意',
  cotton: '棉',
  manufacturer: '制造',
  pottery: '陶',
};

/** 地点显示名（LOCATIONS 英文名；商人位/未知 id 原样）。 */
function locName(id: LocationId | MerchantId): string {
  return LOCATIONS[id]?.name ?? id;
}

function isMerchantNode(x: string): boolean {
  return Object.prototype.hasOwnProperty.call(MERCHANTS, x);
}

/** Link 显示名：a-b（三端点边附 (+额外端点)）。 */
function linkName(linkIndex: number): string {
  const l = LINKS[linkIndex];
  if (!l) return `link#${linkIndex}`;
  const extra = LINK_EXTRA_ENDPOINTS[linkIndex];
  return `${l.a}-${l.b}${extra && extra.length > 0 ? `(+${extra.join('+')})` : ''}`;
}

/** 商人奖励一句话（Sell 用商人桶时触发）。 */
function merchantBonusDesc(merchant: MerchantId): string {
  const b = MERCHANTS[merchant].bonus;
  switch (b.type) {
    case 'vp':
      return `+${b.amount}VP`;
    case 'income':
      return `+${b.amount}收入`;
    case 'money':
      return `+£${b.amount}`;
    case 'develop':
      return '免费研发';
  }
}

/**
 * 紧凑结构化中文局势摘要（纯函数、确定性）。
 * viewer 为自己的座位号；只展示 viewer 的手牌（隐藏信息不泄漏）。
 */
export function summarizeState(state: GameState, viewer: PlayerIndex): string {
  const ps = state.players[viewer];
  if (!ps) throw new RangeError(`summarizeState: unknown viewer ${viewer}`);
  const lines: string[] = [];

  // 1. 时代/轮次/行动计数/顺位
  const era = state.era === 'canal' ? '运河时代' : '铁路时代';
  const order = state.turnOrder.map((p) => `P${p}`).join('>');
  lines.push(
    `【局势】${era} 第${state.round}轮 你是P${viewer} ` +
      `本轮第${state.actionsThisTurn + 1}/${actionsPerRound(state)}个行动 顺位:${order}`,
  );

  // 2. viewer：现金/收入等级/VP/手牌（逐张 id）
  lines.push(
    `【你 P${viewer}】£${ps.money} 收入等级${incomeLevelAt(ps.incomeSpace)} ` +
      `VP${ps.vp} 手牌:${ps.hand.map((c) => c.id).join(' ') || '无'}`,
  );

  // 3. 对手概览（现金/收入/VP；手牌为隐藏信息不展示）
  const others = state.players
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i !== viewer)
    .map(
      ({ p, i }) =>
        `P${i}:£${p.money} 收${incomeLevelAt(p.incomeSpace)} VP${p.vp}`,
    );
  lines.push(`【对手】${others.join(' | ') || '无'}`);

  // 4. viewer 面板栈顶（各产业最低可建等级 × 余量）
  const tops: string[] = [];
  for (const ind of Object.keys(INDUSTRY_CN) as IndustryType[]) {
    const stack = ps.tiles.filter((t) => t.industry === ind);
    const top = stack[0];
    if (top) tops.push(`${INDUSTRY_CN[ind]}${top.level}级×${stack.length}`);
  }
  lines.push(`【面板栈顶】${tops.join(' ')}`);

  // 5. 各人场上板块（地点+产业+等级+翻面态+资源数）
  const byPlayer = new Map<PlayerIndex, string[]>();
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (const t of slots) {
      if (!t) continue;
      const res = t.resources > 0 ? `余${t.resources}` : '';
      const desc =
        `${locName(loc)}:${INDUSTRY_CN[t.tile.industry]}${t.tile.level}级` +
        `(${t.flipped ? '已翻' : '未翻'}${res})`;
      const list = byPlayer.get(t.player);
      if (list) list.push(desc);
      else byPlayer.set(t.player, [desc]);
    }
  }
  const tilesText = state.players
    .map((_, i) => ({ i, list: byPlayer.get(i) }))
    .filter(({ list }) => list && list.length > 0)
    .map(({ i, list }) => `P${i}:${list!.join(' ')}`)
    .join(' | ');
  lines.push(`【场上板块】${tilesText || '无'}`);

  // 6. Link（按玩家分组）
  const linksByPlayer = new Map<PlayerIndex, string[]>();
  for (const bl of state.board.links) {
    const list = linksByPlayer.get(bl.player);
    const name = linkName(bl.linkIndex);
    if (list) list.push(name);
    else linksByPlayer.set(bl.player, [name]);
  }
  const linksText = state.players
    .map((_, i) => ({ i, list: linksByPlayer.get(i) }))
    .filter(({ list }) => list && list.length > 0)
    .map(({ i, list }) => `P${i}:${list!.join(' ')}`)
    .join(' | ');
  lines.push(`【Link】${linksText || '无'}`);

  // 7. 煤/铁市场：存量 + 下一块买价（买空时 helper 给兜底价）
  lines.push(
    `【市场】煤:存${state.coalMarket}块 下块£${buyCoalCost(state, 1)} | ` +
      `铁:存${state.ironMarket}块 下块£${buyIronCost(state, 1)}`,
  );

  // 8. 啤酒分布：自己酒厂桶 / 对手酒厂桶（标注是否与 viewer 网络连通，近似口径——
  //    实际用酒连通锚定"用酒处"，此处给网络连通作决策参考）/ 商人桶（含板块图标）
  const reach = reachableFrom(state, playerNetwork(state, viewer));
  const ownBeer: string[] = [];
  const oppBeer: string[] = [];
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (const t of slots) {
      if (!t || t.flipped || t.tile.industry !== 'brewery' || t.resources <= 0) {
        continue;
      }
      if (t.player === viewer) {
        ownBeer.push(`${locName(loc)}×${t.resources}`);
      } else {
        oppBeer.push(
          `${locName(loc)}(P${t.player})×${t.resources}${reach.has(loc) ? '连通' : ''}`,
        );
      }
    }
  }
  const merchantBeer: string[] = [];
  for (const [id, m] of Object.entries(state.merchants)) {
    const count = m.barrels.filter(Boolean).length;
    if (count === 0) continue;
    const tiles = m.tiles
      .filter((t) => t !== 'blank')
      .map((t) => MERCHANT_TILE_CN[t] ?? t)
      .join('+');
    merchantBeer.push(`${id}[${tiles}]×${count}`);
  }
  lines.push(
    `【啤酒】自己:${ownBeer.join(' ') || '无'} | ` +
      `对手:${oppBeer.join(' ') || '无'} | 商人桶:${merchantBeer.join(' ') || '无'}`,
  );

  // 卖货态势段已移除：v8/v9 bench 实测该段（无论是否配指令性文字）均使
  // k3 均分下降 6-11 VP——信息分散注意力/诱发提前贱卖。留此注释备查。

  // 10. 甲板余量 + Wild 供应
  lines.push(
    `【牌堆】余${state.deck.length}张 ` +
      `Wild:${state.wildSupply.location}地点+${state.wildSupply.industry}产业`,
  );

  return lines.join('\n');
}

function describeBuild(
  state: GameState,
  player: PlayerIndex,
  action: Extract<Action, { type: 'build' }>,
): string {
  const def = state.players[player]?.tiles.find(
    (t) => t.industry === action.industry,
  );
  const where = locName(action.location);
  if (!def) return `在${where}建${INDUSTRY_CN[action.industry]}`;

  const cost = [`£${def.costMoney}`];
  if (def.costCoal > 0) cost.push(`${def.costCoal}煤`);
  if (def.costIron > 0) cost.push(`${def.costIron}铁`);

  const notes: string[] = [];
  if (def.costCoal > 0) {
    const free = coalSources(state, player, action.location).reduce(
      (s, x) => s + x.tile.resources,
      0,
    );
    if (free >= def.costCoal) {
      notes.push('煤连通免费');
    } else if (canBuyCoalFromMarket(state, action.location)) {
      notes.push(`缺${def.costCoal - free}煤市购£${buyCoalCost(state, def.costCoal - free)}`);
    } else {
      notes.push('煤不可达');
    }
  }
  if (def.costIron > 0) {
    const free = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
    if (free >= def.costIron) {
      notes.push('铁免费');
    } else {
      notes.push(`缺${def.costIron - free}铁市购£${buyIronCost(state, def.costIron - free)}`);
    }
  }

  const gains = [`${def.vp}VP`, `${def.incomeAdvance}收入`];
  if (def.linkIcons > 0) gains.push(`${def.linkIcons}Link`);

  // 翻面时机按产业区分——酿酒厂建成放桶不翻面（桶耗尽才翻），消费类板块卖出才翻，
  // 不写清楚 LLM 会误以为建成即拿翻面收益（v3 bench 实测：开局连建酒厂导致收入卡 0）
  let flipLabel = '翻面';
  let extra = '';
  if (def.industry === 'iron') {
    const r = marketSellRevenue(IRON_MARKET_PRICES, state.ironMarket, def.resourcesPlaced);
    if (r.sold > 0) extra = `；建成即卖市场≈£${r.revenue}`;
  } else if (
    def.industry === 'coal' &&
    canBuyCoalFromMarket(state, action.location)
  ) {
    const r = marketSellRevenue(COAL_MARKET_PRICES, state.coalMarket, def.resourcesPlaced);
    if (r.sold > 0) extra = `；建成即卖市场≈£${r.revenue}`;
  } else if (def.industry === 'brewery') {
    flipLabel = '桶耗尽才翻面（建成当下不给）';
    extra = `；建成放${BREWERY_BARRELS[state.era]}桶`;
  } else {
    flipLabel = '卖出才翻面（建成当下不给）';
  }

  return (
    `在${where}建${def.level}级${INDUSTRY_CN[def.industry]}` +
    `（${cost.join('+')}${notes.length > 0 ? `，${notes.join('，')}` : ''}）` +
    `：${flipLabel}${gains.join('+')}${extra}`
  );
}

function describeNetwork(
  state: GameState,
  player: PlayerIndex,
  action: Extract<Action, { type: 'network' }>,
): string {
  const names = action.links.map(linkName).join(' + ');
  // 新连通：所有端点中尚不在己方 network 的（商人位标注）
  const net = playerNetwork(state, player);
  const fresh = new Set<string>();
  for (const idx of action.links) {
    const l = LINKS[idx];
    if (!l) continue;
    for (const e of [l.a, l.b, ...(LINK_EXTRA_ENDPOINTS[idx] ?? [])]) {
      if (!net.has(e)) fresh.add(e);
    }
  }
  const freshText =
    [...fresh]
      .map((e) => `${locName(e)}${isMerchantNode(e) ? '(商人)' : ''}`)
      .join(' ') || '无';
  if (state.era === 'canal') {
    return `铺运河 ${names}（£3）：新连通${freshText}`;
  }
  if (action.links.length === 1) {
    return `铺铁路 ${names}（£5+1煤）：新连通${freshText}`;
  }
  const beer = action.beerFromOpponentBrewery
    ? `${locName(action.beerFromOpponentBrewery)}对手酒厂`
    : '自己酒厂优先';
  return `铺双轨 ${names}（£15+2煤+1啤酒，酒源:${beer}）：新连通${freshText}`;
}

function describeSell(
  state: GameState,
  action: Extract<Action, { type: 'sell' }>,
): string {
  const parts: string[] = [];
  let vp = 0;
  let income = 0;
  for (const sale of action.sales) {
    const placed = state.board.slots[sale.location]?.[sale.slotIndex];
    const tileDesc = placed
      ? `${placed.tile.level}级${INDUSTRY_CN[placed.tile.industry]}`
      : '板块';
    if (placed) {
      vp += placed.tile.vp;
      income += placed.tile.incomeAdvance;
    }
    const beer = sale.useMerchantBeer
      ? `商人桶,奖励${merchantBonusDesc(sale.merchant)}`
      : '酒厂桶';
    parts.push(`${locName(sale.location)}${tileDesc}→${sale.merchant}(${beer})`);
  }
  return `卖出 ${parts.join('，')}：翻面${vp}VP+${income}收入`;
}

function describeDevelop(
  state: GameState,
  player: PlayerIndex,
  action: Extract<Action, { type: 'develop' }>,
): string {
  const ps = state.players[player];
  const removed = new Map<IndustryType, number>();
  for (const ind of action.removals) {
    removed.set(ind, (removed.get(ind) ?? 0) + 1);
  }
  const n = action.removals.length;
  const free = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
  const ironNote =
    free >= n ? '铁免费' : `缺${n - free}铁市购£${buyIronCost(state, n - free)}`;
  const removeDesc = [...removed]
    .map(([ind, k]) => `${INDUSTRY_CN[ind]}${k > 1 ? `×${k}` : ''}`)
    .join('+');
  const upgrades: string[] = [];
  for (const [ind, k] of removed) {
    const next = ps?.tiles.filter((t) => t.industry === ind)[k];
    if (next) upgrades.push(`${INDUSTRY_CN[ind]}→${next.level}级`);
  }
  return (
    `研发移除${removeDesc}（需${n}铁，${ironNote}）` +
    `：解锁${upgrades.join('，') || '无新栈顶'}`
  );
}

function describeLoan(state: GameState, player: PlayerIndex): string {
  const ps = state.players[player];
  if (!ps) return '贷款£30（收入退3级）';
  const cur = incomeLevelAt(ps.incomeSpace);
  const after = incomeLevelAt(loanBacktrack(ps.incomeSpace));
  // 收入等级为负的代价：每轮末从现金扣，现金不足先拆自己板块再直接扣 VP。
  // 让描述显式带出"贷款会把收入打负=慢性扣VP"的后果，压过模型对 £30 的贪欲。
  const warning =
    after < 0
      ? `【警告：贷后收入${after}为负，轮末按等级扣现金（不足拆板块/扣VP）；仅当本回合能翻面转正（铁厂/煤矿建成即翻）时才是强手，否则别选】`
      : cur < 0
        ? `【已在负收入，仅在能立即转正时考虑】`
        : '';
  return `贷款£30（收入等级${cur}→${after}）${warning}`;
}

/**
 * 行动的一句话中文描述（纯函数、确定性），供候选列表与日志。
 * 带决策关键信息：成本、连通、翻面收益、啤酒来源。
 */
export function describeAction(
  state: GameState,
  player: PlayerIndex,
  action: Action,
): string {
  switch (action.type) {
    case 'build':
      return describeBuild(state, player, action);
    case 'network':
      return describeNetwork(state, player, action);
    case 'sell':
      return describeSell(state, action);
    case 'develop':
      return describeDevelop(state, player, action);
    case 'loan':
      return describeLoan(state, player);
    case 'scout':
      return '搜寻：弃3张换Wild地点+Wild产业各1张';
    case 'pass':
      return '跳过行动（弃1张牌）';
  }
}

/**
 * 决策 prompt 的静态 system（**完全静态**：不含任何对局动态内容，两局不同 seed
 * 逐字节相同）——稳定前缀最大化 prompt 缓存命中。动态内容一律放 user。
 *
 * 2026-09-05 全量重写为具体 if-then 指令（GLM vs 0903 三轮 ×90 局复盘沉淀，
 * 见 bench/docs/2026-09-05-glm-vs0903-round2-3.md）：抽象原则被证实遵守是
 * 概率性的，最具体的数字规则遵守率最高（负收入红线）；旧版「运河时代别碰
 * 消费板块」是复盘确诊的错误信念原文出处（消费板块是主得分引擎，错的是
 * 无卖路硬建），「2/3 级煤矿≈终局 VP」为事实错误（收入/现金终局不折 VP）。
 */
export const SYSTEM_PROMPT = [
  '你是桌游 Brass: Birmingham 的决策 AI，为一名玩家选择本回合行动。',
  '目标：胜利分(VP)最高者胜。VP 主要来自翻面的产业板块与翻面板块上 Link 图标所连的已建 Link；收入轨决定每轮发工资。注意：收入和现金在终局都不折算成 VP——它们的价值只在换成的板块和行动上。',
  '规则要点：',
  '- 每回合从候选中选 1 个行动。build 建板块（耗 £，可能耗煤/铁）；network 铺路扩连通（运河 £3/条；铁路 £5/条，或双轨 £15+1 啤酒，每条约耗 1 煤）；sell 卖货（棉纺/制造/陶瓷板块须连通对应图标的商人板块，耗啤酒翻面）；develop 研发（耗铁移除面板低级板块，解锁更高级）；loan 贷款 £30、收入退 3 级；scout 弃 3 张换 2 张 Wild 卡；pass 跳过。',
  '- 翻面是核心：煤/铁厂的资源块耗尽自动翻面（建成时资源自动卖给缺货市场，常当场翻面回血）；酿酒厂建成不翻面，啤酒桶被铺路/卖货消耗尽才翻；棉纺/制造/陶瓷靠 sell 翻面。翻面给 VP、收入前进与 Link 图标。',
  '- 连通：建造/卖货所需煤、啤酒沿已建 Link（任何玩家的）可达即免费取，不足按市场价买；从市场买煤必须连通商人位，买铁不需要连通。',
  '- 时代：运河时代后进入铁路时代（运河末清算，未翻 1 级板块被移除）；状态摘要会给出本时代剩余轮数，你每轮约有 1-2 个行动位。',
  '【硬性数字规则——逐条执行，与其它考虑冲突时以本节为准】',
  '1. 贷款三查，全过才贷：①贷后收入等级 ≥0；②现金 <£40；③非终局（剩余轮数 ≥2 或你是本轮首个行动）。贷后下一个行动必须建「当场翻面」板块（铁厂/煤矿），reason 必须引用该候选编号。唯一例外：现金 <£10 且无任何可负担行动（死锁），此时贷款是唯一解锁手段，贷完立刻建当场翻面板块转正。',
  '2. 煤矿配额：你场上未翻面的煤矿满 2 座后禁止再建煤矿——改建铁厂（同样当场翻面，卖市场回血更快）。负收入修复同理：优先铁厂。',
  '3. 负收入红线：收入等级 <0 时只允许三类行动——当场翻面的建造（优先铁厂）、卖出、£3 运河；1-2 个行动内把收入修回 ≥0。',
  '4. 终局分档（看【前瞻】里的剩余轮数）：剩余 1 轮时只允许「当场翻面的建造 / 卖出 / 已有即时 Link 分的铺轨」——禁止建棉纺/制造/陶瓷/酿酒厂（来不及卖/喝）、禁止贷款、禁止研发、禁止搜寻。现金多就换成当场翻面的高 VP 板块：现金留到终局=作废（£0 折算）。',
  '5. 研发本身 0 VP：它花 1 个行动位 + 铁钱，只为了解锁。只在两种情况下研发：运河时代拆 1 级酿酒厂（解锁 2 级，铁市购价 ≤£2 时）；铁路时代拆的栈能解锁 3 级+棉纺/陶瓷/制造。',
  '【每步检查单——按顺序过，命中即选】',
  '① 候选列表里有「卖出」项且我的对应板块能翻 → 直接选卖出。一次卖多块的优先于单卖；带商人奖励（+VP/+£5/免费研发）的桶优先。',
  '② 不能卖时看消费板块（棉纺/制造/陶瓷）三要素：连通对应商人 + 啤酒够 + 建后还有行动位能卖。三要素全齐 → 建它（这就是主得分引擎，运河时代照样建：建棉纺→下动卖出=5VP+5收入+商人奖励）。缺商人 → 选铺运河/铁路打通；缺啤酒 → 建酿酒厂（桶是卖货弹药，手里有 ≥2 块未翻可售板块时才值得建）。',
  '③ 三要素不全、现金 ≥£10 → 建当场翻面板块：优先铁厂（£5+1 煤，建成卖市场拿回 £5-8 + 3VP + 3 收入），煤矿受配额限制。',
  '④ 现金 £3-10 且收入 ≥0 → 铺 £3 运河打通商人位，或过三查后贷款。',
  '⑤ 现金 <£3 又无可卖 → 铁便宜时研发，否则搜寻；只有所有类型都不可行才 pass（pass=弃 1 牌 + 零产出，一局超过 2 次 pass 基本等于认输）。',
  '【具体时机与数字】',
  '- 开局 R1-R2：建铁厂/当场翻面板块造血，或低价铁时研发酿酒厂 L1；不要开局连铺运河（每条 £3 要花 1 个行动位，连通了却没有产出板块=白花）。',
  '- 收入目标：运河末 ≥10、铁路第 13 轮前 ≥20。收入的作用是每轮买行动位，不是 VP——终局前 2 轮把收入换成当场翻面的板块。',
  '- 铁路时代首动优先双轨（£15+2 煤+1 啤酒 = 一次两条 Link 分），选两端已翻板块多/带商人位的一侧。',
  '- 攒双卖：两个待售板块卖给同一商人只花 1 个行动位；奖励价值 +4VP > +3VP > +£5 > 免费研发 > 无奖励。',
  '- 高价板块（陶瓷 L2+、棉纺 L3+、制造 L4+）单块 7-12VP：三要素全齐就是最优行动之一；但缺商人硬建=£12-17 砸手里 0 VP，这是本 AI 历史最大失分点。',
  '【明确禁止】',
  '- 禁止把「卖出才翻面/桶耗尽才翻面」的候选当当场翻面计价——它们建成时 0 收益，还需再花 1 个行动位；候选里已用【延迟兑现】标注。',
  '- 禁止研发当 VP 来源；禁止引用不存在的手牌/板块；啤酒桶只存在于未翻面的酒厂上（已翻面酒厂不供酒）。',
  '输出方式：调用 choose 工具提交你的选择——choice_index 参数填候选编号（0 起），reason 参数填一句话中文理由。不要输出任何其他内容。',
].join('\n');

/**
 * 构造一次决策的 prompt：system 静态（见 SYSTEM_PROMPT）；user = 局势摘要 +
 * 0-based 编号候选列表（编号与 choiceIndex 对齐）。candidates 顺序即编号顺序。
 */
export function buildDecisionPrompt(
  state: GameState,
  player: PlayerIndex,
  candidates: { action: Action; description: string }[],
): { system: string; user: string } {
  const user = [
    summarizeState(state, player),
    '',
    '【候选行动】（编号 0 起，choose 工具的 choice_index 参数与编号一致）',
    ...candidates.map((c, i) => `${i}. ${c.description}`),
    '',
    '请调用 choose 工具提交选择：choice_index 填候选编号（0 起），reason 填一句话中文理由。',
  ].join('\n');
  return { system: SYSTEM_PROMPT, user };
}
