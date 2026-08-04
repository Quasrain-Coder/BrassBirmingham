# BrassBirmingham

A local, self-hostable digital implementation of the board game **Brass: Birmingham**
rules, playable in the browser with friends (LAN or internet) and/or LLM-driven AI
players, with a post-game coaching review of your moves.

**Status: M2 (online multiplayer) complete.** Rules engine (M1), authoritative
WebSocket server with rooms/reconnect/SQLite history, and the browser client
(lobby + SVG board + action interactions) are all done. Next: M3 (LLM AI seats).
See `docs/superpowers/specs/` for the design doc.

## Quick start (dev)

```bash
npm install

# terminal 1: game server (ws on :8420, SQLite at ./brass.db)
npm run dev -w @brass/server

# terminal 2: web client (vite on :5173, /ws proxied to :8420)
npm run dev -w @brass/web
# → open http://localhost:5173 in two browser windows to play
```

Single-port production-style run (static files + `/ws` on the same port):

```bash
npm run build -w @brass/web
WEB_DIST=$PWD/packages/web/dist npm run dev -w @brass/server
# → open http://localhost:8420
```

Server env vars: `PORT` (default 8420), `DB_PATH` (default `./brass.db`),
`WEB_DIST` (static root; unset in dev — vite serves the client).

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

## Features

- [x] Full game rules: canal era + rail era, 2–4 players
- [x] Browser multiplayer via an authoritative WebSocket server (rooms + short codes)
- [x] Persistent game history (SQLite), replayable action logs, reconnect support
- [ ] AI seats powered by an LLM (Claude API), constrained to engine-enumerated legal moves (M3)
- [ ] Post-game review report: per-move analysis with concrete alternatives and reasoning (M5)

## Legal note

This is an unofficial, non-commercial fan project. It contains **no original game
artwork, card text, or other copyrighted assets** — the board is an original,
simplified SVG rendering. Game mechanics themselves are not copyrightable.
"Brass: Birmingham" is a trademark of its publisher; this project is not affiliated
with or endorsed by them.

## License

MIT (code only, see the legal note above)
