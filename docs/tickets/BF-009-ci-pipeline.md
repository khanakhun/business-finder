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
- [x] CI runs on PRs and `main`, with caching and affected-only execution on PRs.
- [x] Jobs auto-skip when their target (e.g. `apps/web/e2e`, a Dockerfile) does not exist yet.
- [x] Boundary violations, stale generated code and migration drift fail CI.
- [x] gitleaks and OSV scans run; CodeQL configured; Renovate configured.
- [x] `docs/CI.md` lists required checks for branch protection.

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

## Implementation notes
- **Actions (pinned by SHA)**: checkout v7.0.1, setup-node v7.1.0, pnpm/action-setup v6.1.0 (reads `packageManager`),
  cache v6.1.0, setup-uv v10.3.0, paths-filter v4.0.3, setup-buildx v4.4.1, build-push v7.4.0, login v4.6.0,
  metadata v6.2.0, upload-artifact v7.0.2, osv-scanner-action v2.7.0, codeql-action v4.38.3; gitleaks CLI 8.30.1
  (checksum-verified download, so full history can be scanned on `main` — the action only scans the push range).
  Workflows lint clean with actionlint 1.7.12 (+ shellcheck).
- **Affected-only**: `turbo run … --filter=...[<PR base sha>]` (the PR base, not `origin/main`, so stacked PRs
  work); root tasks run separately with `--filter=//`. Docs-only PRs run `changes` + `security` only.
- **Auto-skip**: `changes` reports which targets exist (`hashFiles()` is not available in job-level `if`);
  generators run only if their script exists; images come from `infra/docker/images.json`, filtered to existing
  Dockerfiles (api/web/sites/agent-runner listed ahead of their tickets).
- **Postgres image** built once per job with the Buildx GHA cache (scope `postgres`), passed to Testcontainers via
  `BF_TEST_PG_IMAGE`; `infra:up` gained `BF_INFRA_SKIP_BUILD=1` so E2E reuses it instead of compiling pgvector.
- **Boundaries**: `scripts/check-boundaries.mjs` (TypeScript pre-processor for imports, data-driven rule table,
  0.3 s on the repo) + 7 node:test cases on generated fixture trees. Rules: app→app, package→app, contracts leaf
  (src only — tool configs may use @bf/testing), pure domain (frameworks/DB/HTTP/outer layers), no server packages
  in apps/web.
- **Security exceptions**: `.gitleaks.toml` allowlists the prose value `S3-compatible` (a generic-api-key false
  positive in docs); `osv-scanner.toml` ignores GHSA-67mh-4wv8-2f99 (dev-only esbuild 0.18 via drizzle-kit; affects
  esbuild's `serve` only) until 2027-01-15. `pnpm audit --prod` is advisory.
- **Found while running the pipeline in a clean checkout**: `@bf/config`'s repo-root test assumed the clone folder
  name; an empty `biome.jsonc.tmp` had been committed in BF-007. Both fixed. First GitHub run also caught a bug in
  my gitleaks step (checksum file name), fixed.
- **Verification (no PR possible from here)**: a temporary commit added `bf-009-ci-pipeline` to the push trigger;
  run 38658177302 was fully green (quality, integration, e2e, generated, db, boundaries, security); run 38661866837
  with a deliberate domain violation showed a red `boundaries`; both temporary commits are reverted.
- **Renovate** chosen over Dependabot (pnpm catalogs, `uv.lock`, Docker digests, grouping); needs the Renovate
  GitHub App installed by the owner.

