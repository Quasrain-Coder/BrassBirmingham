/**
 * AgentBGA 风格 LLM 插件：observe/legal_actions 工具循环 + 1010 降级。
 * 系统提示只有座次、游戏名和工具，不额外注入棋理或规则书。
 */
import type { Action, GameState, PlayerIndex } from '@brass/engine';
import type { AgentDecisionReasoning, AgentInstance, AgentPlugin, DecideInput } from './contract.js';
import type { DecidingAgent } from '../decision.js';
import jsbV20261010 from './jsb-v20261010.js';
import { decisionTurn } from './decision-turn.js';
import {
  AGENTBGA_TOOLS,
  legalActions,
  projectObservation,
  resolveActionId,
} from './agentbga-adapter.js';
import { AgentBGAClient, AgentBGAClientError } from './agentbga-client.js';

export interface AgentBGAClientLike {
  decide(req: {
    system: string;
    user: string;
    tools: typeof AGENTBGA_TOOLS;
    invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
  }): Promise<{ actionId: string; usage: { input: number; output: number }; reasoning?: AgentDecisionReasoning }>;
}

interface HistoryItem {
  version: number;
  actionId?: string;
  fallback?: string;
}

export function createAgentBGAPlugin(opts?: {
  client?: AgentBGAClientLike;
  fallback?: DecidingAgent;
}): AgentPlugin {
  return {
    meta: {
      name: 'agentbga-llm',
      version: '1.0.0',
      description: 'AgentBGA 风格 observe/legal_actions 工具循环 LLM（1010 降级）',
      author: 'brass-birmingham',
    },
    create: (ctx): AgentInstance => {
      const client = opts?.client ?? new AgentBGAClient();
      const fallbackInstance = opts?.fallback === undefined ? jsbV20261010.create(ctx) : null;
      const fallback: DecidingAgent = opts?.fallback ?? {
        decide: async (state, seat, legal) => ({
          action: await fallbackInstance!.decide({ state, seat, legal }),
          reason: 'jsb-v20261010',
          degraded: true,
          usage: { input: 0, output: 0 },
        }),
      };
      let notes = '';
      let history: HistoryItem[] = [];
      let lastMeta: {
        reason: string;
        degraded: boolean;
        usage: { input: number; output: number };
        reasoning?: AgentDecisionReasoning;
      } = {
        reason: 'agentbga-llm',
        degraded: true,
        usage: { input: 0, output: 0 },
      };

      const rules = (topic?: unknown) => {
        const topics: Record<string, string> = {
          overview: 'Brass: Birmingham has canal and rail eras. Build industries and links, develop tiles, sell goods, and score VP.',
          actions: 'build, network, develop, sell, loan, scout, and pass are the available action types. Submit only an ID returned by legal_actions.',
          scoring: 'VP comes from flipped industries and links. Unflipped industries do not provide their printed VP.',
          markets: 'Coal and iron are limited by the current market. Beer comes from breweries or merchant tiles when the relevant action allows it.',
        };
        if (typeof topic !== 'string' || topic.length === 0) return { topics: Object.keys(topics) };
        return { topic, content: topics[topic] ?? 'Unknown rules topic' };
      };

      const decide = async (input: DecideInput): Promise<Action> => {
        const { state, seat, legal } = input;
        const version = decisionTurn(state);
        const actions = legalActions(state, seat, legal);
        const invoke = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
          switch (name) {
            case 'observe':
              return projectObservation(state, seat);
            case 'legal_actions':
              return actions;
            case 'inspect_rules':
              return rules(args.topic);
            case 'inspect_history': {
              const since = typeof args.since_version === 'number' ? args.since_version : -1;
              const cursor = typeof args.cursor === 'number' && args.cursor >= 0 ? args.cursor : 0;
              const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 20;
              const filtered = history.filter((item) => item.version > since);
              return {
                total: filtered.length,
                cursor,
                next_cursor: cursor + limit < filtered.length ? cursor + limit : null,
                items: filtered.slice(cursor, cursor + limit),
              };
            }
            case 'read_notes':
              return { content: notes };
            case 'write_notes':
              notes = String(args.content ?? '').slice(0, 4000);
              return { ok: true };
            case 'submit_action': {
              const id = typeof args.action_id === 'string' ? args.action_id : '';
              const action = resolveActionId(id, actions);
              return action ? { ok: true, actionId: id } : { ok: false, error: 'illegal or stale action id' };
            }
            default:
              return { error: `unknown tool: ${name}` };
          }
        };
        let resultUsage: { input: number; output: number } | undefined;
        try {
          const result = await client.decide({
            system: `You are seat ${seat} in an AgentBGA brass_birmingham match. Available tools: observe, legal_actions, inspect_rules, inspect_history, read_notes, write_notes, submit_action.`,
            user: `State version ${version}. Call observe, legal_actions, then submit_action with exactly one legal action ID.`,
            tools: AGENTBGA_TOOLS,
            invoke,
          });
          resultUsage = result.usage;
          const action = resolveActionId(result.actionId, actions);
          if (!action) throw new Error(`model returned an illegal action id: ${result.actionId}`);
          history = [...history.slice(-199), { version, actionId: result.actionId }];
          lastMeta = {
            reason: `agentbga:${result.actionId}`,
            degraded: false,
            usage: result.usage,
            ...(result.reasoning ? { reasoning: result.reasoning } : {}),
          };
          return action;
        } catch (error) {
          if (process.env['BRASS_AI_ALLOW_FALLBACK'] === '0') throw error;
          const cause = error instanceof Error ? error.message : String(error);
          const usage = error instanceof AgentBGAClientError ? error.usage : resultUsage ?? { input: 0, output: 0 };
          const degraded = await fallback.decide(state, seat, legal);
          history = [...history.slice(-199), { version, fallback: cause }];
          lastMeta = { reason: `AgentBGA 降级（${cause}）；${degraded.reason}`, degraded: true, usage };
          return degraded.action;
        }
      };
      return {
        decide,
        decisionMeta: () => lastMeta,
      };
    },
  };
}

export default createAgentBGAPlugin();
