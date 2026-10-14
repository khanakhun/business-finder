# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Start a ticket with the slash command `/ticket BF-0NN`. It loads the ticket, its dependencies and the relevant docs, and walks you through the workflow in AGENTS.md §5.
- Use plan mode for L-sized tickets: produce the plan, then implement.
- Delegate focused reviews to subagents in `.claude/agents/`: `code-reviewer` (correctness, patterns, tests), `security-reviewer` (authz, injection, SSRF, secrets), `test-engineer` (missing cases, flakiness). Run them on your diff before opening the PR.
- Prefer the Context7 MCP server (if configured) for current library documentation; otherwise fetch official docs. Never rely on remembered APIs for Better Auth, Drizzle, BullMQ, Next.js, NestJS, Puck, the AI SDK or the Claude Agent SDK — they change between versions.
- Keep the context window lean: read files you need, use search tools instead of dumping directories, and do not paste large generated files into the conversation.
- GitHub: this repository's issues mirror `docs/tickets/`. Use `gh api repos/{owner}/{repo}/issues/<n>` (REST) when you need issue metadata.
