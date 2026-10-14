# ADR-0001: Monorepo with pnpm workspaces, Turborepo and uv

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-001, BF-009

## Context

The system has three TypeScript apps (dashboard, API/worker, site renderer), a dozen shared TypeScript packages (contracts, db, ai, site blocks…), a Python service and a sandbox image. Contracts must stay in sync across all of them, and the code is written largely by AI coding agents that work best when all related code, docs and tickets are in one place and one `verify` command checks everything.

## Decision

- One Git repository.
- **pnpm workspaces** for TypeScript packages (`apps/*`, `packages/*`), with `workspace:*` protocol for internal deps and a single lockfile.
- **Turborepo** for task orchestration (`build`, `lint`, `typecheck`, `test`, `test:int`, `e2e`), with remote cache optional and `--filter=...[origin/main]` for affected-only runs in CI.
- **uv** for the Python service (`services/intel`): `pyproject.toml`, `uv.lock`, tasks via `taskipy` (`uv run task verify`). Root `pnpm` scripts proxy to it so `pnpm verify` covers Python too.
- Internal TypeScript packages are consumed as source (TS project references / `exports` pointing to `src` in dev, built `dist` in Docker images) to keep the inner loop fast.
- Package scope `@bf/*`.

## Alternatives considered

| Option | Why not |
|---|---|
| Polyrepo (one repo per app/service) | Contract drift, multi-PR changes for one feature, agents lose cross-repo context. |
| Nx | Powerful but heavier and more opinionated; Turborepo covers our needs with less configuration. |
| npm/yarn workspaces | pnpm's strict `node_modules` catches undeclared deps (important with many agent-written packages) and is faster/disk-efficient. |
| Poetry / pip-tools for Python | uv is faster, handles Python versions and lockfiles in one tool. |

## Consequences

- Positive: atomic cross-cutting changes; one CI; shared tooling; agents can read every contract and ticket.
- Positive: affected-only builds keep CI time reasonable as the repo grows.
- Negative: two package managers (pnpm + uv) — mitigated by root scripts and documented commands.
- Negative: Docker builds need pruning (`turbo prune --docker`) to avoid copying the whole repo.

## References

- Turborepo docs: https://turborepo.com/docs
- pnpm workspaces: https://pnpm.io/workspaces
- uv: https://docs.astral.sh/uv/
