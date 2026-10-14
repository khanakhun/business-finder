---
id: BF-009
title: CI pipeline (GitHub Actions) and quality gates
milestone: M0 Foundations
epic: foundations
type: infra
priority: P0
size: M
depends_on: [BF-001]
blocks: [BF-025]
areas: [ci]
---

# BF-009 — CI pipeline (GitHub Actions) and quality gates

## Context
Coding agents will open many PRs in parallel. CI is the safety net that enforces conventions agents might miss: lint, types, tests, generated-code freshness, migration drift, module boundaries, secrets and dependency vulnerabilities. Later tickets add apps incrementally, so the pipeline must adapt automatically to what exists (Turborepo handles missing tasks; jobs for E2E/images must skip when their app is absent).

## Goal
A fast, cached GitHub Actions pipeline that runs only what a PR affects, enforces all quality gates documented in `docs/conventions/testing.md §8`, builds container images on `main`, and is ready for branch protection.

## Scope
**In scope**
- `.github/workflows/ci.yml` (PRs + pushes to `main`; `concurrency` cancels superseded runs):
  - `setup` composite action: checkout (fetch-depth for affected detection), Node 24 + corepack pnpm, pnpm store cache, Turborepo cache (`actions/cache` on `.turbo` keyed by lockfile + sha, or Turborepo remote cache if `TURBO_TOKEN` is set), uv + cache when `services/intel` exists.
  - `quality`: `pnpm turbo run lint typecheck test --filter=...[origin/main]` on PRs, full on `main`; uploads coverage summaries; fails under thresholds.
  - `integration`: `pnpm turbo run test:int --filter=...[origin/main]` (Docker available on `ubuntu-latest` for Testcontainers); builds the custom Postgres image once and passes it via `BF_TEST_PG_IMAGE`.
  - `generated`: `pnpm api:codegen`, `pnpm contracts:jsonschema`, `pnpm contracts:py`, `pnpm env:doc`, `pnpm env:example` → `git diff --exit-code` (each step skipped if its script doesn't exist yet).
  - `db`: `pnpm db:check` when `packages/db` changed.
  - `boundaries`: `node scripts/check-boundaries.mjs` (implemented here): parses imports in `apps/*` and `packages/*` (fast regex/TS parser), enforces the rules in AGENTS.md §3 (no app→app, no package→app, contracts imports nothing internal, `domain/` folders import no framework/DB/HTTP libraries), prints violations with file:line.
  - `e2e` (only if `apps/web/e2e` exists and web/api changed): compose up (infra + built apps), migrate, seed, Playwright with retries=0, upload traces/videos on failure.
  - `security`: gitleaks (full history on `main`, diff on PRs), OSV-Scanner on lockfiles (`pnpm-lock.yaml`, `uv.lock`), `pnpm audit --prod` (advisory, non-blocking initially).
  - `images` (on `main` only, after quality/integration): matrix build with Buildx + GHA cache for each Dockerfile that exists (`api`, `web`, `sites`, `intel`, `agent-runner`, `postgres`), `turbo prune --docker` for Node apps, push to GHCR as `ghcr.io/<owner>/bf-<image>:<sha>` and `:main`.
- `.github/workflows/codeql.yml` (JS/TS + Python, weekly + PR to main).
- `.github/dependabot.yml` **or** `renovate.json` (choose Renovate with grouped updates, weekly schedule, automerge for patch devDependencies after CI) — document the choice.
- `docs/CI.md`: what each job does, how to reproduce locally (`act` optional), required checks list for branch protection (`quality`, `integration`, `generated`, `boundaries`, `security`), how to add a new image.

**Out of scope**
- Deploy workflows (→ BF-025 staging, BF-061 production). Nightly evals and performance jobs (added by BF-013/BF-022 as separate workflows).

## Requirements
### Functional
- A PR touching only `docs/` runs in < 2 min (path filters + affected detection).
- A PR violating a boundary rule fails with a readable message.
### Non-functional
- Typical PR pipeline < 12 min with warm caches. Secrets used only in `images` (GHCR via `GITHUB_TOKEN`).
- Workflows pin third-party actions by commit SHA (document how to update).

## Design
- Use `dorny/paths-filter` (pinned SHA) or Turborepo affected detection to compute which jobs run.
- Composite action `.github/actions/setup/action.yml` shared by jobs.
- `scripts/check-boundaries.mjs`: rule table data-driven (`[{ from: 'apps/web/**', disallow: ['apps/**', '@bf/db'] }, …]`), unit-tested with fixtures in `scripts/__tests__/`.

## Implementation plan
1. Verify current action versions/SHAs (checkout, setup-node, pnpm action or corepack, cache, docker buildx, login, gitleaks, osv-scanner, codeql).
2. Composite setup action; quality + generated + boundaries jobs (work with the current repo state).
3. Integration/e2e/images jobs gated on existence of the relevant directories/files.
4. Security jobs, CodeQL, Renovate config.
5. `docs/CI.md`; recommend branch-protection settings (the repo owner applies them in GitHub settings).

## Testing
- `scripts/check-boundaries.mjs` unit tests with fixture trees (allowed and violating imports).
- Pipeline exercised on this PR: green run; a temporary commit with a boundary violation shows a red `boundaries` job (then reverted) — link both runs in the PR.

## Acceptance criteria
- [ ] CI runs on PRs and `main`, with caching and affected-only execution on PRs.
- [ ] Jobs auto-skip when their target (e.g. `apps/web/e2e`, a Dockerfile) does not exist yet.
- [ ] Boundary violations, stale generated code and migration drift fail CI.
- [ ] gitleaks and OSV scans run; CodeQL configured; Renovate configured.
- [ ] `docs/CI.md` lists required checks for branch protection.

## Agent prompt
```text
Implement BF-009 (CI pipeline and quality gates).

Read first: AGENTS.md (§3, §4, §9), docs/conventions/testing.md (§1, §8), docs/conventions/security.md §9,
docs/ARCHITECTURE.md §4 and §15.

Rules:
- Look up current versions of every GitHub Action you use and pin them by full commit SHA with a version
  comment. Do not guess SHAs — fetch them.
- The pipeline must pass on the current repo (only some packages exist). Every job that depends on a later
  ticket's artifact must detect its absence and skip cleanly.
- Keep it fast: affected-only on PRs, caches for pnpm, Turborepo, uv and Docker layers.

Verify: open the PR and link a green run; demonstrate a failing boundaries run with a temporary violation.
```

## References
- AGENTS.md §3–§4 · docs/conventions/testing.md §8 · docs/conventions/security.md §9
- Turborepo in CI: https://turborepo.com/docs/crafting-your-repository/constructing-ci · Testcontainers on GitHub Actions: https://node.testcontainers.org/ · gitleaks: https://github.com/gitleaks/gitleaks · OSV-Scanner: https://google.github.io/osv-scanner/
