/**
 * 公共 API 冒烟：消费方（server / web / AI 席位）只允许从包入口 import。
 * 本文件唯一的 import 源是 '../src/index.js'——禁止深路径；新增公共导出时
 * 在此同步冒烟。
 */
import { describe, expect, it } from 'vitest';
import {
  // 核心入口
  newGame,
  enumerateActions,
  applyAction,
  RandomAgent,
  playGame,
  createRng,
  IllegalActionError,
  stableStringify,
  // 版图/板块/牌组数据
  LOCATIONS,
  LINKS,
  LINK_EXTRA_ENDPOINTS,
  MERCHANTS,
  neighborsOf,
  TILES,
  tileDef,
  buildDeck,
  WILD_INDUSTRY_COUNT,
  WILD_LOCATION_COUNT,
  // 网络 / 资源 / 市场
  playerNetwork,
  isConnected,
  connectedMerchants,
  coalSources,
  ironSources,
  canBuyCoalFromMarket,
  reachableFrom,
  applyFlip,
  consumeBeer,
  consumeCoal,
  consumeIron,
  buyCoalCost,
  buyIronCost,
  marketBuyCost,
  marketSellRevenue,
  sellCoalToMarket,
  sellIronToMarket,
  // 各行动枚举/执行
  enumerateBuilds,
  applyBuild,
  enumerateNetwork,
  applyNetwork,
  enumerateDevelop,
  applyDevelop,
  enumerateLoan,
  applyLoan,
  enumerateScout,
  applyScout,
  applyPass,
  enumerateSells,
  applySell,
  // 回合 / 时代
  actionsPerRound,
  eraEndCondition,
  endTurnIfNeeded,
  checkEraEnd,
  finalScore,
  scoreEraLinks,
  scoreFlippedIndustries,
  // 收入轨 / 市场常量
  INCOME_LEVEL_SPACES,
  INCOME_LEVEL_MAX,
  INCOME_LEVEL_MIN,
  INCOME_START_SPACE,
  INCOME_TRACK_MAX_SPACE,
  INCOME_TRACK_MIN_SPACE,
  advanceIncomeSpace,
  incomeLevelAt,
  loanBacktrack,
  BREWERY_BARRELS,
  COAL_FALLBACK_PRICE,
  COAL_MARKET_INITIAL_FILLED,
  COAL_MARKET_PRICES,
  IRON_FALLBACK_PRICE,
  IRON_MARKET_INITIAL_FILLED,
  IRON_MARKET_PRICES,
} from '../src/index.js';
import type {
  Action,
  Card,
  GameState,
  PlayerAgent,
  PlayerIndex,
} from '../src/index.js';

describe('public api barrel', () => {
  it('exposes the core entry points as functions', () => {
    for (const fn of [
      newGame, enumerateActions, applyAction, playGame, createRng, stableStringify,
      enumerateBuilds, applyBuild, enumerateNetwork, applyNetwork, enumerateDevelop,
      applyDevelop, enumerateLoan, applyLoan, enumerateScout, applyScout, applyPass,
      enumerateSells, applySell, actionsPerRound, eraEndCondition, endTurnIfNeeded,
      checkEraEnd, finalScore, scoreEraLinks, scoreFlippedIndustries,
      playerNetwork, isConnected, connectedMerchants, coalSources, ironSources,
      canBuyCoalFromMarket, reachableFrom, applyFlip, consumeBeer, consumeCoal,
      consumeIron, buyCoalCost, buyIronCost, marketBuyCost, marketSellRevenue,
      sellCoalToMarket, sellIronToMarket, neighborsOf, tileDef, buildDeck,
      advanceIncomeSpace, incomeLevelAt, loanBacktrack,
    ]) {
      expect(typeof fn).toBe('function');
    }
    expect(typeof RandomAgent).toBe('function'); // class
    expect(IllegalActionError.prototype).toBeInstanceOf(Error);
  });

  it('exposes data constants', () => {
    expect(Object.keys(LOCATIONS)).toHaveLength(22); // 20 城镇 + 2 农场酿酒厂
    expect(LINKS).toHaveLength(39);
    expect(LINK_EXTRA_ENDPOINTS[29]).toEqual(['farm-south']);
    expect(Object.keys(MERCHANTS)).toHaveLength(5);
    expect(TILES).toHaveLength(29);
    expect(buildDeck(2)).toHaveLength(40);
    expect(buildDeck(3)).toHaveLength(54);
    expect(buildDeck(4)).toHaveLength(64);
    expect(WILD_LOCATION_COUNT).toBe(4);
    expect(WILD_INDUSTRY_COUNT).toBe(4);
    expect(COAL_MARKET_PRICES).toHaveLength(14);
    expect(IRON_MARKET_PRICES).toHaveLength(10);
    expect(COAL_MARKET_INITIAL_FILLED).toBe(13);
    expect(IRON_MARKET_INITIAL_FILLED).toBe(8);
    expect(COAL_FALLBACK_PRICE).toBe(8);
    expect(IRON_FALLBACK_PRICE).toBe(6);
    expect(BREWERY_BARRELS).toEqual({ canal: 1, rail: 2 });
    expect(INCOME_LEVEL_SPACES(30)).toEqual([97, 99]);
    expect(INCOME_LEVEL_MAX).toBe(30);
    expect(INCOME_LEVEL_MIN).toBe(-10);
    expect(INCOME_START_SPACE).toBe(10);
    expect(INCOME_TRACK_MAX_SPACE).toBe(99);
    expect(INCOME_TRACK_MIN_SPACE).toBe(0);
  });

  it('smoke: newGame → enumerateActions → applyAction through the barrel only', () => {
    const s: GameState = newGame(3, 7);
    const current: PlayerIndex = s.turnOrder[s.currentPlayerIdx]!;
    const legal: Action[] = enumerateActions(s, current);
    expect(legal.length).toBeGreaterThan(0);
    const next = applyAction(s, legal[0]!);
    expect(next).not.toBe(s); // 不可变更新
    expect(stableStringify(next)).not.toBe(stableStringify(s));
  });

  it('smoke: playGame with default RandomAgents terminates', () => {
    const { state, log } = playGame(2, 1);
    expect(state.phase).toBe('game-over');
    expect(state.winner).not.toBeNull();
    expect(log.length).toBeGreaterThan(0);
  });

  it('smoke: custom PlayerAgent (typed via barrel) can drive a seat', () => {
    const firstPick: PlayerAgent = { chooseAction: (_s, legal) => legal[0]! };
    const { state } = playGame(2, 2, [firstPick, new RandomAgent(99)]);
    expect(state.phase).toBe('game-over');
  });

  it('type-only imports resolve (compile-time check)', () => {
    const card: Card = { id: 'c', kind: 'location', location: 'birmingham' };
    expect(card.kind).toBe('location');
  });
});
