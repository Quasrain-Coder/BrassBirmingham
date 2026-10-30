import { enumerateActions, newGame } from '@brass/engine';
import { createAgent } from '../src/agents/registry.js';

const state = newGame(4, 42);
const seat = state.turnOrder[state.currentPlayerIdx]!;
const legal = enumerateActions(state, seat);
const agent = createAgent('builtin:agentbga-llm', { seat });
const started = performance.now();
const decision = await agent.decide(state, seat, legal);
console.log(JSON.stringify({
  action: decision.action,
  reason: decision.reason,
  degraded: decision.degraded,
  usage: decision.usage,
  reasoningRounds: decision.reasoning?.rounds.length ?? 0,
  reasoningChars: decision.reasoning?.rounds.reduce((sum, round) => sum + round.reasoning.length, 0) ?? 0,
  reasoning: decision.reasoning ?? null,
  elapsedMs: Math.round(performance.now() - started),
}, null, 2));
