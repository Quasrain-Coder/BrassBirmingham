# BrassBirmingham

A local, self-hostable digital implementation of the board game **Brass: Birmingham**
rules, playable in the browser with friends (LAN or internet) and/or LLM-driven AI
players, with a post-game coaching review of your moves.

**Status: M3 (LLM AI seats) complete.** Rules engine (M1), authoritative
WebSocket server with rooms/reconnect/SQLite history (M2), the browser client,
and LLM-driven AI seats with heuristic fallback (M3) are all done. Next: M5
(post-game coaching review). See `docs/superpowers/specs/` for the design doc.

## Quick start (dev)

```bash
npm install

# official art assets ship in packages/web/public/assets/ (personal non-commercial use);
# to regenerate from source: npm run fetch-assets -w @brass/web

# terminal 1: game server (ws on :8420, SQLite at ./brass.db)
npm run dev -w @brass/server

# terminal 2: web client (vite on :5174, /ws proxied to :8420)
npm run dev -w @brass/web
# → open http://localhost:5174 in two browser windows to play
```

Single-port production-style run (static files + `/ws` on the same port):

```bash
npm run build -w @brass/web
WEB_DIST=$PWD/packages/web/dist npm run dev -w @brass/server
# → open http://localhost:8420
```

Server env vars: `PORT` (default 8420), `DB_PATH` (default `./brass.db`),
`WEB_DIST` (static root; unset in dev — vite serves the client),
`ANTHROPIC_API_KEY` (enables LLM-driven AI seats; without it AI seats fall back
to the built-in heuristic and no API calls are made), `BRASS_AI_MODEL` (override
the per-difficulty default model). See `.env.example`.

Checks:

```bash
npm run typecheck   # all workspaces
npm test            # all workspaces (vitest + coverage)
```

## Milestones

- **M1: rules engine (`packages/engine`)** — done. Deterministic, dependency-free
  TypeScript implementation of the full game rules: canal + rail eras, 2–4
  players, all six action types, market/income/merchant mechanics, era transition
  and final scoring. State transitions are pure and seed-deterministic — any
  action log replays to a byte-identical final state. Public API (import only
  from the package root `@brass/engine`): `newGame(playerCount, seed)`,
  `enumerateActions(state, player)`, `applyAction(state, action)`, plus
  `RandomAgent` / `playGame` self-play drivers; consumers must not deep-import
  internals.
- **M2: online multiplayer (`packages/protocol` + `packages/server` + `packages/web`)** — done.
  - `packages/protocol`: versioned client/server message types shared by both ends.
  - `packages/server`: authoritative game server — room lobby with 6-char codes,
    token-based seats, ws transport with heartbeat, disconnect/reconnect
    (`resume` restores your seat and current snapshot), per-seat hidden
    information (other players' hands are counts only), and SQLite persistence
    (games/actions/seats; every applied action lands in the `actions` table,
    finished games store their final state for replay).
  - `packages/web`: React client — lobby (create/join with optional public seed
    flag), room waiting view, SVG board with legal-target highlighting, action
    bar for all six action types, info panels, and auto-reconnect.
- **M3: LLM AI seats (`packages/llm` + server/web integration)** — done.
  Rooms can fill empty seats with AI players (up to playerCount − 1). Each AI
  seat is driven by a decision chain: board-state summary → candidate prescreen
  → LLM choice (Claude tool use, constrained to engine-enumerated legal actions)
  → engine validation → fallback. Three difficulties: **easy** (claude-haiku-4-5,
  top-8 candidates), **normal** (claude-sonnet-4-5, top-20), **hard**
  (claude-sonnet-4-5, top-40 plus an era-progress/rounds-left lookahead section
  in the prompt). Degradation chain, in order: LLM choice (one retry on an
  invalid pick) → `HeuristicAgent` top-1 fallback (validation failure, API
  error/timeout, or missing `ANTHROPIC_API_KEY` — flagged `degraded`, and the
  game never stalls). The client shows "AI thinking" indicators and per-move
  reasons.
  - **Cost note:** with `ANTHROPIC_API_KEY` set, each AI decision costs roughly
    **$0.005–0.01** (usage-priced), so a full game with AI seats lands around
    **$0.3–0.8** depending on player count and game length. Without the key,
    AI seats run purely on the local heuristic at zero cost.

## Features

- [x] Full game rules: canal era + rail era, 2–4 players
- [x] Browser multiplayer via an authoritative WebSocket server (rooms + short codes)
- [x] Persistent game history (SQLite), replayable action logs, reconnect support
- [x] AI seats powered by an LLM (Claude API), constrained to engine-enumerated legal moves (M3)
- [x] Pluggable AI framework: one file per AI, two built-in heuristics (see below)
- [ ] Post-game review report: per-move analysis with concrete alternatives and reasoning (M5)

## Pluggable AI

An AI is a **single-file plugin**. Contributing a new one takes two steps —
no changes to the server or engine:

1. Add one file in `packages/llm/src/agents/` that default-exports an
   `AgentPlugin` (contract: `packages/llm/src/agents/contract.ts`).
2. Register one line in `BUILTIN_PLUGINS` in
   `packages/llm/src/agents/registry.ts`.

The plugin receives everything it needs per decision — full `GameState`,
its seat, the engine-enumerated legal actions, and an optional time
budget — and returns one action from the legal set:

```ts
// packages/llm/src/agents/first-legal.ts — a minimal example plugin
import type { AgentPlugin } from './contract.js';

const plugin: AgentPlugin = {
  meta: {
    name: 'first-legal',
    version: '1.0.0',
    description: 'Toy example: always plays the first legal action',
    author: 'you',
  },
  create: () => ({
    decide: ({ legal }) => legal[0]!,
  }),
};

export default plugin;
```

```ts
// registry.ts — one line:
const BUILTIN_PLUGINS: Record<string, AgentPlugin> = {
  'lm-heuristic-v20260826': lmV20260826,
  'lm-heuristic-v20260829': lmV20260829,
  'jsb-v20260831': jsbV20260831,
  'jsb-v20260901': jsbV20260901,
  'jsb-v20260902': jsbV20260902,
  'first-legal': firstLegal, // ← your line
};
```

Select it for AI seats with an env var (LLM path is unchanged and takes
precedence when `ANTHROPIC_API_KEY` is set):

```sh
BRASS_AI_SPEC=builtin:first-legal npm run dev -w @brass/server
```

Built-ins: `lm-heuristic-v20260826` / `lm-heuristic-v20260829`
(faithful ports of two generations of the Eluvk/brass-assistant
heuristic, named by upstream date), `jsb-v20260831` (our tuned fork
of lm-0829 — endgame sell-window guidance + brewery-sell combo),
`jsb-v20260901` (canal-era L2+ double-scoring correction,
flip-precision fixes and sell-batching guidance) and `jsb-v20260902`
(the default — MCTS-style position evaluator as the 2-ply leaf;
beats jsb-0901 71.5% and lm-0829 84% over paired head-to-head games).
An `exec:<path>`
transport for external single-file agents (Python/Rust, stdio NDJSON with
the same payload shape) is planned next — `contract.ts` doubles as its
protocol document.

## Legal note

This is an unofficial, **personal, non-commercial** fan project (for the
owner's own play). It may use original game artwork and card text as
personal-use materials; where no original asset is available it falls back to
original, simplified SVG rendering. Game mechanics themselves are not
copyrightable. "Brass: Birmingham" is a trademark of its publisher; this
project is not affiliated with or endorsed by them.

## License

MIT (code only, see the legal note above)
