# Claude Code stream fixtures (BF-044)

SYNTHESIZED, not recorded. No model key was available when they were written. Each line follows the stream-json shapes
of Claude Code 2.1.288: the `system/init` line was observed in the runner image (offline, fake key), and the rest
follows the Agent SDK's `sdk.d.ts` types (`SDKAssistantMessage`, `SDKUserMessage`, `SDKResultSuccess`/`SDKResultError`).

The success fixture ends with an unknown message type, a `rate_limit_event` and a line that is not JSON: parsers
must skip them. Replace the files with recorded runs when the
CLI is bumped (a recording script is a follow-up: it needs model keys). `*.events.json` are the golden event sequences the parser produces.
