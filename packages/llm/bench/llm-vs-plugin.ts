/**
 * 1×LLM(k3, 新 prompt) vs 3×jsb-v20260902b 对抗基准。
 * LLM 席位按局轮换消除顺位偏差；统计人均 VP / 胜率 / degraded 率 / token 用量。
 * 用法: ANTHROPIC_API_KEY=... ANTHROPIC_BASE_URL=... BRASS_AI_MODEL=k3 \
 *   npx vite-node bench/llm-vs-plugin.ts [局数=10]
 */
import { applyAction, enumerateActions, newGame } from '@brass/engine';
import { AnthropicClient } from '../src/client.js';
import { LLMAgent } from '../src/llm-agent.js';
import { createAgent } from '../src/agents/registry.js';
import { describeAction } from '../src/summarize.js';

const GAMES = Number(process.argv[2] ?? 10);
const SPEC = 'builtin:jsb-v20260902b';
const client = new AnthropicClient({});

let llmVp = 0, jsbVp = 0, llmWins = 0, decisions = 0, degraded = 0, inTok = 0, outTok = 0;
const t0 = Date.now();

for (let g = 0; g < GAMES; g++) {
  const seed = g;
  const llmSeat = g % 4; // 轮换 LLM 座位
  const agents = [0, 1, 2, 3].map((seat) =>
    seat === llmSeat ? new LLMAgent(client, 'normal') : createAgent(SPEC, { seat }),
  );
  let state = newGame(4, seed);
  let steps = 0;
  while (state.phase !== 'game-over') {
    const player = state.turnOrder[state.currentPlayerIdx]!;
    const legal = enumerateActions(state, player);
    if (legal.length === 0) throw new Error(`no legal at ${steps}`);
    const d = await agents[player]!.decide(state, player, legal);
    if (player === llmSeat) {
      decisions += 1;
      inTok += d.usage.input;
      outTok += d.usage.output;
      if (d.degraded) {
        degraded += 1;
        console.log(`  [g${g} 步${steps}] degraded，理由: ${d.reason.slice(0, 60)}`);
      } else {
        console.log(`  [g${g} 步${steps}] LLM: ${describeAction(state, player, d.action).slice(0, 50)} | ${d.reason.slice(0, 40)}`);
      }
    }
    state = applyAction(state, d.action);
    if (++steps > 100_000) throw new Error('runaway');
  }
  const vps = state.players.map((p) => p.vp);
  const winVp = Math.max(...vps);
  const won = vps[llmSeat] === winVp;
  llmVp += vps[llmSeat]!;
  jsbVp += vps.reduce((s, v, i) => (i === llmSeat ? s : s + v), 0);
  if (won) llmWins += 1;
  console.log(`game ${g} (LLM=P${llmSeat}): ${vps.map((v, i) => `${i === llmSeat ? 'L' : 'J'}=${v}`).join(' ')} ${won ? '★LLM胜' : ''} [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
}

console.log('---');
console.log(`LLM(k3 新prompt): 人均 ${(llmVp / GAMES).toFixed(1)} | 胜率 ${((llmWins / GAMES) * 100).toFixed(0)}% (${llmWins}/${GAMES})`);
console.log(`jsb-0902b:        人均 ${(jsbVp / GAMES / 3).toFixed(1)}`);
console.log(`LLM 决策 ${decisions} 次, degraded ${degraded} (${((degraded / decisions) * 100).toFixed(1)}%), token in=${inTok} out=${outTok}, 总耗时 ${((Date.now() - t0) / 60000).toFixed(1)}min`);
