---
description: Run every quality gate for the current branch and summarize results
---

Run the verification suite for the current branch and report a concise summary table (check → status → notes):

1. `pnpm verify` (lint, typecheck, unit tests for all workspaces).
2. `pnpm test:int` if `packages/db`, `apps/api` or any adapter changed versus `origin/main` (use `git diff --name-only origin/main...HEAD`).
3. `pnpm e2e` if `apps/web` or user-facing API routes changed.
4. `uv run task verify` in `services/intel` if Python files changed.
5. `pnpm api:codegen && git diff --exit-code` and `pnpm contracts:py && git diff --exit-code` to detect stale generated code.
6. `pnpm db:check` (Drizzle drift check) if the schema changed.

If anything fails, investigate the root cause and fix it; do not skip or weaken tests. Report what you changed.
