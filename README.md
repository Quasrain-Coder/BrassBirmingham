# BrassBirmingham

A local, self-hostable digital implementation of the board game **Brass: Birmingham**
rules, playable in the browser with friends (LAN or internet) and/or LLM-driven AI
players, with a post-game coaching review of your moves.

**Status: M1 (rules engine) complete.** See `docs/superpowers/specs/` for the design doc.

## M1: rules engine (`packages/engine`)

Deterministic, dependency-free TypeScript implementation of the full game rules:
canal + rail eras, 2–4 players, all six action types, market/income/merchant
mechanics, era transition and final scoring. State transitions are pure and
seed-deterministic — any action log replays to a byte-identical final state.

```bash
npm install
npm run typecheck   # all workspaces
npm test            # engine tests + coverage (vitest, ≥85% line coverage)
```

Public API (import only from the package root — `@brass/engine`, backed by
`packages/engine/src/index.ts`): `newGame(playerCount, seed)` creates a game,
`enumerateActions(state, player)` lists legal moves, `applyAction(state, action)`
advances state, and `RandomAgent` / `playGame` drive full self-play games; all
public types and rules-data constants (board, tiles, deck, markets, income
track) are exported from the same entry point. Consumers must not deep-import
internals.


## Features (planned)

- Full game rules: canal era + rail era, 2–4 players
- Browser multiplayer via an authoritative WebSocket server (rooms + short codes)
- AI seats powered by an LLM (Claude API), constrained to engine-enumerated legal moves
- Post-game review report: per-move analysis with concrete alternatives and reasoning
- Persistent game history (SQLite), replayable action logs, reconnect support

## Legal note

This is an unofficial, non-commercial fan project. It contains **no original game
artwork, card text, or other copyrighted assets** — the board is an original,
simplified SVG rendering. Game mechanics themselves are not copyrightable.
"Brass: Birmingham" is a trademark of its publisher; this project is not affiliated
with or endorsed by them.

## License

MIT (code only, see the legal note above)
