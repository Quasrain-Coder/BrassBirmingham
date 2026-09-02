/**
 * 时代切换清算与终局计分（rules-reference §7，[R p.7]）。
 *
 * turn.ts 的 endTurnIfNeeded 在轮末检出时代结束条件（eraEndCondition）后置
 * eraEndPending 并立即调用本模块的 checkEraEnd 消费之：
 * - 运河时代末：Link 计分 → 翻面产业计分 → 移除全部 1 级板块 → 商人啤酒补满
 *   （每块非 blank 商人板块旁补到 1 桶）→ 弃牌堆合洗成新 deck（wild 不在弃牌堆，
 *   弃置时已回 wild 供应堆 §9.14）→ 重抽 8 张 → era='rail'。
 *   RNG 延续方式：GameState.rngState 存当前种子状态，重洗用 createRng(state.rngState)
 *   继续，洗完把 rng.getState() 写回（newGame 之外唯一消耗 rng 的地方）。
 * - 铁路时代末：Link 计分 → 翻面产业计分 → phase='game-over'，winner 判定
 *   （VP 高 → 收入等级高（incomeLevelAt(incomeSpace)）→ 现金多 → 共同获胜数组）；
 *   钱与收入不折 VP（§9.18）。
 *
 * 纯函数：不改入参。
 */
import { LINK_EXTRA_ENDPOINTS, LINKS, MERCHANTS } from './data/board.js';
import { incomeLevelAt } from './data/income.js';
import { createRng } from './rng.js';
import type { GameState } from './state.js';
import type { LocationId, MerchantId, PlayerIndex } from './types.js';

const HAND_SIZE = 8;

/** 某地点内已翻面板块的连接图标总数（未翻面板块不提供连接图标，§9.6）。 */
function flippedLinkIcons(state: GameState, location: LocationId): number {
  let n = 0;
  for (const t of state.board.slots[location] ?? []) {
    if (t && t.flipped) n += t.tile.linkIcons;
  }
  return n;
}

/**
 * Link 计分：每条 Link，两端（含 LINK_EXTRA_ENDPOINTS 附加端点，如
 * kidderminster–worcester 边同时计 farm-south）计：
 * - 相邻**地点**内已翻面板块的 linkIcons 之和；
 * - 相邻**商人位**各 +2（商人位板面印 2 个连接图标，实物版图目视核实 2026-08-26：
 *   如 Warrington 横幅上方的两个六边形链环图标；brass-assistant/npow 同为 +2）。
 * VP 给 Link owner；计分后全部 Link 从版图移除。
 * @param clear 是否计分后移除 Link（运河末清算 = true，规则要求；终局 = false，
 * 游戏结束版图应保留建成状态供展示/回放——此前一律 true 导致终局帧铁路全消失）。
 */
export function scoreEraLinks(state: GameState, clear = true): GameState {
  if (state.board.links.length === 0) return state;
  const gains = new Map<PlayerIndex, number>();
  for (const link of state.board.links) {
    const def = LINKS[link.linkIndex]!;
    let vp = 0;
    for (const endpoint of [def.a, def.b, ...(LINK_EXTRA_ENDPOINTS[link.linkIndex] ?? [])]) {
      if (Object.prototype.hasOwnProperty.call(MERCHANTS, endpoint)) {
        vp += 2;
      } else {
        vp += flippedLinkIcons(state, endpoint);
      }
    }
    gains.set(link.player, (gains.get(link.player) ?? 0) + vp);
  }
  return {
    ...state,
    players: state.players.map((p, i) => ({ ...p, vp: p.vp + (gains.get(i) ?? 0) })),
    board: { ...state.board, links: clear ? [] : state.board.links },
  };
}

/** 翻面产业计分：所有玩家场上翻面板块按印刷 vp 入账；未翻面不计。 */
export function scoreFlippedIndustries(state: GameState): GameState {
  const gains = new Array<number>(state.playerCount).fill(0);
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.flipped) gains[t.player]! += t.tile.vp;
    }
  }
  if (gains.every((g) => g === 0)) return state;
  return {
    ...state,
    players: state.players.map((p, i) => ({ ...p, vp: p.vp + gains[i]! })),
  };
}

/** 运河末：移除场上全部 1 级板块（翻面未翻面都移，连同资源退出游戏）；2 级+保留。 */
function removeLevelOneTiles(state: GameState): GameState {
  const slots = {} as GameState['board']['slots'];
  for (const [location, arr] of Object.entries(state.board.slots)) {
    slots[location] = arr.map((t) => (t && t.tile.level === 1 ? null : t));
  }
  return { ...state, board: { ...state.board, slots } };
}

/** 运河末：商人啤酒补满——每块非 blank 商人板块旁补到 1 桶；blank 不补。 */
function refillMerchantBeer(state: GameState): GameState {
  const merchants = { ...state.merchants };
  for (const id of Object.keys(merchants) as MerchantId[]) {
    const m = merchants[id];
    merchants[id] = { ...m, barrels: m.tiles.map((t) => t !== 'blank') };
  }
  return { ...state, merchants };
}

/** 运河末：弃牌堆合洗成新 deck（延续 state.rngState 的 rng 流）并重抽 8 张/人。 */
function reshuffleAndDeal(state: GameState): GameState {
  const rng = createRng(state.rngState);
  const deck = rng.shuffle(state.discard);
  const players = state.players.map((p) => ({
    ...p,
    hand: deck.splice(0, HAND_SIZE),
  }));
  return { ...state, players, deck, discard: [], rngState: rng.getState() };
}

/** 运河时代末清算 → 铁路时代开始（铁路第 1 轮正常 2 行动，见 turn.ts actionsPerRound）。 */
function canalToRail(state: GameState): GameState {
  let next = scoreEraLinks(state);
  next = scoreFlippedIndustries(next);
  next = removeLevelOneTiles(next);
  next = refillMerchantBeer(next);
  next = reshuffleAndDeal(next);
  return { ...next, era: 'rail', eraEndPending: false };
}

/** winner 判定：VP 高 → 收入等级高 → 现金多 → 共同获胜。钱/收入不折 VP。 */
function determineWinners(state: GameState): PlayerIndex[] {
  const key = (i: PlayerIndex) => {
    const p = state.players[i]!;
    return { vp: p.vp, income: incomeLevelAt(p.incomeSpace), money: p.money };
  };
  let winners: PlayerIndex[] = [];
  for (let i = 0; i < state.playerCount; i++) {
    if (winners.length === 0) {
      winners = [i];
      continue;
    }
    const a = key(i);
    const b = key(winners[0]!);
    if (a.vp !== b.vp) {
      if (a.vp > b.vp) winners = [i];
    } else if (a.income !== b.income) {
      if (a.income > b.income) winners = [i];
    } else if (a.money !== b.money) {
      if (a.money > b.money) winners = [i];
    } else {
      winners.push(i); // 完全并列 → 共同获胜
    }
  }
  return winners;
}

/**
 * 终局（铁路时代末）：Link 计分 → 翻面产业计分 → phase='game-over' 并判定 winner。
 * 不做运河末步骤（1 级板块移除/啤酒补满/重洗重抽均不适用）。
 * Link 计分后**不移除**（clear=false）：游戏结束版图保留建成状态供展示/回放。
 */
export function finalScore(state: GameState): GameState {
  let next = scoreEraLinks(state, false);
  next = scoreFlippedIndustries(next);
  return {
    ...next,
    phase: 'game-over',
    winner: determineWinners(next),
    eraEndPending: false,
  };
}

/**
 * 消费 eraEndPending：canal → 运河末清算进入铁路时代；rail → 终局计分。
 * eraEndPending 未置位时原样返回。endTurnIfNeeded 在轮末置位后立即调用。
 */
export function checkEraEnd(state: GameState): GameState {
  if (!state.eraEndPending) return state;
  return state.era === 'canal' ? canalToRail(state) : finalScore(state);
}
