/**
 * AgentBGA 风格观察与合法动作适配（接口思路源自 MIT 许可的 AgentBGA）。
 * 本项目引擎仍是唯一规则来源；这里只做座位安全投影和 ID 映射。
 */
import {
  COAL_MARKET_PRICES,
  IRON_MARKET_PRICES,
  LINKS,
  LINK_EXTRA_ENDPOINTS,
  LOCATIONS,
  MERCHANTS,
  actionsPerRound,
  type Action,
  type GameState,
  type IndustryType,
  type PlayerIndex,
} from '@brass/engine';
import type Anthropic from '@anthropic-ai/sdk';
import { decisionTurn } from './decision-turn.js';

const INDUSTRY_NAME: Record<IndustryType, string> = {
  cotton: 'cotton_mill',
  coal: 'coal_mine',
  iron: 'iron_works',
  manufacturer: 'manufacturer',
  pottery: 'pottery',
  brewery: 'brewery',
};

export interface AgentBGALegalAction {
  id: string;
  action: Action;
}

export interface AgentBGAObservation {
  game: 'brass_birmingham';
  rules_version: string;
  implementation_status: 'playable_beta';
  viewer_seat: PlayerIndex;
  status: 'active' | 'finished';
  phase: 'choose_action' | 'finished';
  era: GameState['era'];
  round: number;
  turn_count: number;
  decision_count: number;
  active_seat: PlayerIndex;
  turn_order: PlayerIndex[];
  turn: Record<string, unknown>;
  deck_count: number;
  wild_cards: GameState['wildSupply'];
  markets: { coal: { occupied: boolean[] }; iron: { occupied: boolean[] } };
  board: Record<string, unknown>;
  players: Record<string, unknown>[];
  rankings: PlayerIndex[] | null;
}

function market(resource: 'coal' | 'iron', filled: number): { occupied: boolean[] } {
  const prices = resource === 'coal' ? COAL_MARKET_PRICES : IRON_MARKET_PRICES;
  return { occupied: prices.map((_, index) => index >= prices.length - filled) };
}

function boardProjection(state: GameState): Record<string, unknown> {
  const locations = Object.entries(LOCATIONS).map(([id, def]) => ({
    id,
    industry_slots: def.slots.map((slot, index) => ({
      id: `slot-${id}-${index}`,
      accepts: slot.industries.map((industry) => INDUSTRY_NAME[industry]),
    })),
  }));
  const industries = Object.entries(state.board.slots).flatMap(([location, slots]) => (
    slots.flatMap((placed, slotIndex) => {
      if (!placed) return [];
      return [{
        id: `industry-${location}-${slotIndex}`,
        owner: placed.player,
        industry: INDUSTRY_NAME[placed.tile.industry],
        location,
        slot_id: `slot-${location}-${slotIndex}`,
        flipped: placed.flipped,
        resources: placed.resources,
        level: placed.tile.level,
      }];
    })
  ));
  return {
    locations,
    connection_spaces: LINKS.map((link, index) => ({
      id: `connection-${String(index + 1).padStart(2, '0')}`,
      endpoints: [link.a, link.b, ...(LINK_EXTRA_ENDPOINTS[index] ?? [])],
      available_eras: [
        ...(link.canal ? ['canal'] : []),
        ...(link.rail ? ['rail'] : []),
      ],
    })),
    links: state.board.links.map((link) => ({
      connection_id: `connection-${String(link.linkIndex + 1).padStart(2, '0')}`,
      owner: link.player,
      era: link.era,
    })),
    industries,
    merchant_locations: Object.entries(state.merchants).map(([id, merchant]) => ({
      id,
      slots: merchant.tiles.map((tile, index) => ({
        id: `merchant-${id}-${index}`,
        buys: tile,
        beer: merchant.barrels[index] ? 1 : 0,
      })),
    })),
  };
}

export function projectObservation(state: GameState, seat: PlayerIndex): AgentBGAObservation {
  const active = state.turnOrder[state.currentPlayerIdx]!;
  const total = actionsPerRound(state);
  const players = state.players.map((player, index) => {
    const industryStacks: Record<string, unknown[]> = {};
    for (const tile of player.tiles) {
      const key = INDUSTRY_NAME[tile.industry];
      (industryStacks[key] ??= []).push(tile);
    }
    return {
      seat: index,
      money: player.money,
      vp: player.vp,
      income_position: player.incomeSpace,
      spent_this_round: player.spentThisRound,
      links_remaining: 15 - state.board.links.filter((link) => link.player === index).length,
      hand_count: player.hand.length,
      hand: index === seat ? player.hand : [],
      discard: state.discard,
      industry_stacks: industryStacks,
      removed_industries: [],
      wild_cards: {
        location: player.hand.filter((card) => card.kind === 'wild-location').length,
        industry: player.hand.filter((card) => card.kind === 'wild-industry').length,
      },
    };
  });
  return {
    game: 'brass_birmingham',
    rules_version: 'roxley-2018.11-playable-beta.2',
    implementation_status: 'playable_beta',
    viewer_seat: seat,
    status: state.phase === 'game-over' ? 'finished' : 'active',
    phase: state.phase === 'game-over' ? 'finished' : 'choose_action',
    era: state.era,
    round: state.round,
    turn_count: decisionTurn(state),
    decision_count: decisionTurn(state),
    active_seat: active,
    turn_order: [...state.turnOrder],
    turn: {
      active_seat: active,
      actions_total: total,
      actions_remaining: total - state.actionsThisTurn,
      phase: 'choose_action',
      decision: 'choose_action',
    },
    deck_count: state.deck.length,
    wild_cards: { ...state.wildSupply },
    markets: { coal: market('coal', state.coalMarket), iron: market('iron', state.ironMarket) },
    board: boardProjection(state),
    players,
    rankings: state.winner,
  };
}

export function legalActions(_state: GameState, seat: PlayerIndex, legal: Action[]): AgentBGALegalAction[] {
  const version = decisionTurn(_state);
  return legal.map((action, index) => ({
    id: `a_${seat}_${version}_${index}`,
    action,
  }));
}

export function resolveActionId(id: string, legal: AgentBGALegalAction[]): Action | undefined {
  return legal.find((entry) => entry.id === id)?.action;
}

export const AGENTBGA_TOOLS: Anthropic.Tool[] = [
  {
    name: 'observe',
    description: 'Read your seat-scoped current board-game observation.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'legal_actions',
    description: 'List every legal action and its stable action ID for this decision step.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'inspect_rules',
    description: 'Read an engine rules overview or one rules topic when details matter.',
    input_schema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_history',
    description: 'Read seat-safe action history accumulated across prior decisions.',
    input_schema: {
      type: 'object',
      properties: {
        since_version: { type: 'integer', minimum: 0 },
        cursor: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_notes',
    description: 'Read your persistent strategy notes.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'write_notes',
    description: 'Replace your persistent strategy notes with new content.',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_action',
    description: 'Commit exactly one legal action ID for this decision step.',
    input_schema: {
      type: 'object',
      properties: { action_id: { type: 'string' } },
      required: ['action_id'],
      additionalProperties: false,
    },
  },
];
