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
    if (m.beer <= 0) continue;
    const tiles = m.tiles
      .filter((t) => t !== 'blank')
      .map((t) => MERCHANT_TILE_CN[t] ?? t)
      .join('+');
    merchantBeer.push(`${id}[${tiles}]×${m.beer}`);
  }
  lines.push(
    `【啤酒】自己:${ownBeer.join(' ') || '无'} | ` +
      `对手:${oppBeer.join(' ') || '无'} | 商人桶:${merchantBeer.join(' ') || '无'}`,
  );

  // 9. 甲板余量 + Wild 供应
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
    extra = `；建成放${BREWERY_BARRELS[state.era]}桶`;
  }

  return (
    `在${where}建${def.level}级${INDUSTRY_CN[def.industry]}` +
    `（${cost.join('+')}${notes.length > 0 ? `，${notes.join('，')}` : ''}）` +
    `：翻面${gains.join('+')}${extra}`
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
  return `贷款£30（收入等级${cur}→${after}）`;
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
      return '侦察：弃3张换Wild地点+Wild产业各1张';
    case 'pass':
      return '跳过行动（弃1张牌）';
  }
}

/**
 * 决策 prompt 的静态 system（**完全静态**：不含任何对局动态内容，两局不同 seed
 * 逐字节相同）——稳定前缀最大化 prompt 缓存命中。动态内容一律放 user。
 */
export const SYSTEM_PROMPT = [
  '你是桌游 Brass: Birmingham 的决策 AI，为一名玩家选择本回合行动。',
  '目标：胜利分(VP)最高者胜。VP 主要来自翻面的产业板块与翻面板块上 Link 图标所连的已建 Link；收入轨决定每轮发工资。',
  '规则要点：',
  '- 每回合从候选中选 1 个行动。build 建板块（耗 £，可能耗煤/铁）；network 铺路扩连通（运河 £3/条；铁路 £5/条，或双轨 £15+1 啤酒，每条约耗 1 煤）；sell 卖货（棉纺/制造/陶瓷板块须连通对应图标的商人板块，耗啤酒翻面）；develop 研发（耗铁移除面板低级板块，解锁更高级）；loan 贷款 £30、收入退 3 级；scout 弃 3 张换 2 张 Wild 卡；pass 跳过。',
  '- 翻面是核心：煤/铁/酿酒厂资源耗尽自动翻面；棉纺/制造/陶瓷靠 sell 翻面。翻面给 VP、收入前进与 Link 图标。',
  '- 连通：建造/卖货所需煤、啤酒沿已建 Link（任何玩家的）可达即免费取，不足按市场价买；从市场买煤必须连通商人位，买铁不需要连通。',
  '- 时代：运河时代后进入铁路时代（运河末清算）；1 级板块（除陶瓷）铁路时代不可建，且运河时代末移除。',
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
