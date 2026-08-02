# BrassBirmingham

A local, self-hostable digital implementation of the board game **Brass: Birmingham**
rules, playable in the browser with friends (LAN or internet) and/or LLM-driven AI
players, with a post-game coaching review of your moves.

**Status: early design phase.** See `docs/superpowers/specs/` for the design doc.

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
