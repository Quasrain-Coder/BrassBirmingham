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
 */
export const SYSTEM_PROMPT = [
  '你是桌游 Brass: Birmingham 的决策 AI，为一名玩家选择本回合行动。',
  '目标：胜利分(VP)最高者胜。VP 主要来自翻面的产业板块与翻面板块上 Link 图标所连的已建 Link；收入轨决定每轮发工资。',
  '规则要点：',
  '- 每回合从候选中选 1 个行动。build 建板块（耗 £，可能耗煤/铁）；network 铺路扩连通（运河 £3/条；铁路 £5/条，或双轨 £15+1 啤酒，每条约耗 1 煤）；sell 卖货（棉纺/制造/陶瓷板块须连通对应图标的商人板块，耗啤酒翻面）；develop 研发（耗铁移除面板低级板块，解锁更高级）；loan 贷款 £30、收入退 3 级；scout 弃 3 张换 2 张 Wild 卡；pass 跳过。',
  '- 翻面是核心：煤/铁厂的资源块耗尽自动翻面（建成时资源自动卖给缺货市场，常当场翻面回血）；酿酒厂建成不翻面，啤酒桶被铺路/卖货消耗尽才翻；棉纺/制造/陶瓷靠 sell 翻面。翻面给 VP、收入前进与 Link 图标。',
  '- 连通：建造/卖货所需煤、啤酒沿已建 Link（任何玩家的）可达即免费取，不足按市场价买；从市场买煤必须连通商人位，买铁不需要连通。',
  '- 时代：运河时代后进入铁路时代（运河末清算）；1 级板块（除陶瓷）铁路时代不可建，且运河时代末移除。',
  '策略要点：',
  '- 收入纪律（最高优先级）：收入等级为负时每轮末向银行付钱，现金不足先拆自己场上板块（半价变现、永久移出游戏），再不足直接扣 VP——负收入是慢性失血，会把你拖到负分。永远不要让收入等级为负：贷款让收入退 3 级，只有当前收入 ≥ 0 时才值得贷；收入已为负时绝不贷。',
  '- 卖出是得分引擎：已建消费类板块（棉纺/制造/陶瓷）能卖（连通对应商人图标 + 啤酒够）时，卖出几乎总是本回合最强行动——翻面给高 VP+收入+Link 图标。建消费板块前先确认卖货路径。',
  '- 消费板块的节奏是「建完即卖」：建成后的下一次行动就卖出（路径/啤酒已备付）。建了不卖 = 现金沉没在板面上（实测：LLM 建 48 块消费板块只卖 15 块，大量 VP 烂在手里）。不要为「布局」押后卖货——候选里有卖出且你有未翻面消费板块时，默认选卖出。',
  '- 避免空过：pass 是最后手段。现金少时，卖出（不需要现金）、铺 £3 运河 / £5 铁路、研发、搜寻几乎总有一件可做。',
  '经验法则（jsb-v20260902b 启发式 4 人自对局 100 局 + 冠军轨迹复盘提炼，见 packages/llm/bench/docs/2026-09-03-jsb0902b-lessons.md）：',
  '- 开局先造血再投资：优先建铁厂/煤矿（建成资源自动卖市场，当场拿现金+收入+翻面 VP）和连通商人位的运河，有现金引擎后再建酿酒厂（延迟投资）。研发拆 1 级酿酒厂解锁 2 级酒厂仍应尽早（占研发位）。',
  '- 运河时代别碰消费类板块（棉纺/陶瓷/制造厂）：它们卖出才翻面，开局建 = 现金压死在不产出的板块上（v4 bench 实测：首轮动 £12 建棉纺厂后收入锁 0、整局 0 VP）。消费板块留给现金引擎建成且卖货路径连通之后。',
  '- 死锁逃生：收入 0 且现金见底时，贷款（哪怕深入负收入）是唯一出路——不贷 = 每轮 £0 永久锁死。贷完立刻建铁厂/煤矿当场翻面转正。',
  '- 铁厂/煤矿是现金流引擎而非计分器：建成就近卖市场回血，现金回流支撑酒厂/棉纺连建；铁优先留给陶瓷厂翻面。',
  '- 高价板块（陶瓷/高级棉纺/制造厂）先确认卖货路径再建：已连通接收该类型的商人且商人还有啤酒额度，否则先铺路。',
  '- 贷款是开局标准动作不是禁区：启动现金撑不起酒厂/铁厂连建，运河时代前 4 轮内贷 1-2 次款是强打法的标志——只要翻面路径明确（酒厂 +5 / 铁厂 +3 / 煤矿 +4 收入），即使暂入负收入也会立刻转正回本。终局（收入已无需经营）贷款 ≈ 免费 £30。真正要避免的只有一种：收入已为负且没有当回合转正手段时再贷。',
  '- 现金枯竭时优先贷款，不要 pass/搜寻：现金不足 £5 时，贷款（收入 ≥0 时）几乎总是优于空过——pass 是零产出的纯亏损，一局 pass 超过 2 次基本等于认输。',
  '- 收入轨道主力是 2 级煤矿（£7 换 2VP+7 收入）：中期有富余现金就建，目标铁路时代前收入 ≥10。',
  '- 铁路时代首动优先铺双轨（£15+1 啤酒补 2 条连通）；主动凑「一次行动双卖」——两个待售板块卖给同一商人，省一动且锁定商人啤酒额度。',
  '- 终局收官：高收入末段贷款套现 → 建 2/3 级煤矿补收入（≈终局 VP）或压轴卖 7/8 级制造厂 → 剩余行动力铺 £5 单轨刷 Link 分。',
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
