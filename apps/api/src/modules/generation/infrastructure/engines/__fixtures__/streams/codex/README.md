# Codex stream fixtures (BF-044)

SYNTHESIZED, not recorded. No model key was available when they were written. They follow the `exec --json` event
types of Codex CLI 0.160.0 (`codex-rs/exec/src/exec_events.rs` at `rust-v0.160.0`). The `thread.started`,
`turn.started` and reconnect `error` lines match what the CLI printed offline in the runner image.

The success fixture holds a top-level `error` (a recoverable reconnect), an unknown event and a non-JSON line:
parsers must skip them. Replace the files with recorded runs when the CLI is bumped (a recording script is a
follow-up: it needs model keys). `*.events.json` are the golden event sequences the parser produces.
