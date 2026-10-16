# Continuous integration

GitHub Actions runs `.github/workflows/ci.yml` on every pull request and every push to `main`, and
`.github/workflows/codeql.yml` on PRs to `main`, pushes to `main` and weekly. Pull requests run only what they
affect; `main` runs everything and then publishes container images. Jobs whose target does not exist yet (the
E2E suite, a Dockerfile, `services/intel`) skip themselves, so the pipeline grows with the repository.

## Jobs

| Job | Runs when | What it does | Reproduce locally |
|---|---|---|---|
| `changes` | always | Path filters: is anything besides docs changed? did `packages/db` change? do the E2E and site suites exist? | — |
| `quality` | code changed | Root lint + script tests, then `turbo run lint typecheck test` for **affected** packages (`--filter=...[<PR base>]`; everything on `main`). Coverage gates live in the test runners (Vitest per package, pytest ≥ 85 %); the job prints a coverage table to the run summary and uploads the reports. | `pnpm verify` |
| `integration` | code changed | Builds the Postgres image once (GitHub layer cache), passes it as `BF_TEST_PG_IMAGE`, runs `turbo run test:int` for affected packages (Testcontainers: real Postgres + Valkey). | `pnpm test:int` |
| `generated` | code changed | Re-runs `api:codegen`, `contracts:py`, `env:doc`, `env:example` (each only if the script exists) and fails if anything differs from the commit; then `gen:module:check`. | the same scripts, then `git status` |
| `db` | `packages/db` changed | `pnpm db:check`: migration journal consistent and no schema change without a migration. | `pnpm db:check` |
| `boundaries` | code changed | `scripts/check-boundaries.mjs`: the dependency rules of AGENTS.md §3 (no app → app, no package → app, `@bf/contracts` is a leaf, pure `domain/` folders, no server packages in the dashboard). Prints `file:line [rule]`. | `pnpm check:boundaries` |
| `e2e` | web/api/packages/infra changed and `apps/web/playwright.config.ts` exists | Throwaway secrets → `pnpm infra:up` (cached Postgres image, `BF_INFRA_SKIP_BUILD=1`) → migrate → seed → Playwright with **no retries**; traces and screenshots uploaded on failure. | `pnpm infra:up && pnpm db:migrate && pnpm e2e` |
| `sites` | `packages/site-blocks` or `packages/site-schema` changed and `packages/site-blocks/playwright.config.ts` exists | Builds the site stylesheet, renders the four fixture sites in the five styles and the block gallery (`prepare:suites`), then Playwright visual regression (Linux baselines in `packages/site-blocks/suites/__screenshots__`) and axe (no serious/critical violation) with **no retries**, then Lighthouse CI budgets (performance, accessibility, best practices ≥ 0.95, mobile). Diffs and reports uploaded on failure. | `pnpm --filter @bf/site-blocks prepare:suites && pnpm --filter @bf/site-blocks test:visual` (`test:a11y`, `test:lighthouse`) |
| `security` | always | gitleaks (the PR's commits; full history on `main`), OSV-Scanner on every lockfile (`pnpm-lock.yaml`, `uv.lock`), `pnpm audit --prod` (advisory, never fails the run). | see below |
| `images` + `publish` | push to `main`, after `quality` and `integration` | Builds every image in `infra/docker/images.json` whose Dockerfile exists, with Buildx + layer cache, SBOM and provenance; pushes `ghcr.io/<owner>/bf-<name>:<sha>` and `:main`. | `docker build -f <dockerfile> <context>` |
| `deploy-staging` (`deploy-staging.yml`) | CI succeeded on a push to `main`, or by hand (from `main`) with a sha of `main` | Uploads the compose file and `infra/deploy/deploy.sh` **from main** through the key's forced command, then the server pulls that sha's images, migrates, updates the containers and checks health through Caddy — rolling back to the previous release on failure; then `scripts/smoke-staging.mjs` from outside. One deploy at a time; older builds are skipped. | [staging runbook](runbooks/staging-setup.md) |
| CodeQL `analyze` | PR to `main`, push to `main`, weekly | `security-extended` queries for JavaScript/TypeScript, Python and the workflows (`build-mode: none`). | — |

A docs-only pull request runs `changes` and `security` only (about a minute). Superseded PR runs are cancelled;
runs on `main` always finish.

### Security scans locally

```bash
# gitleaks (same version and config as CI)
gitleaks git --redact .
# OSV-Scanner
docker run --rm -v "$PWD":/src ghcr.io/google/osv-scanner:v2.7.0 scan source --recursive /src
pnpm audit --prod
```

Exceptions are narrow and explained: `.gitleaks.toml` (allowlisted *values*, never paths with real secrets — a
leaked secret is rotated, not allowlisted) and `osv-scanner.toml` (each ignored advisory has a reason and an
`ignoreUntil` date, after which the scan fails again).

## Branch protection

Recommended for `main` (Settings → Branches → Add rule; the repository owner applies it):

- Require a pull request before merging; require status checks to pass; require branches to be up to date.
- **Required checks:** `quality`, `integration`, `generated`, `boundaries`, `security`. `db` and `e2e` can be
  required too: a job skipped by its `if:` condition counts as passed.
- Require conversation resolution; block force pushes and deletions; optionally require CodeQL results
  (`analyze (javascript-typescript)`, `analyze (python)`).

## Caching

- **pnpm store** — `actions/setup-node` with `cache: pnpm` (keyed by `pnpm-lock.yaml`).
- **Turborepo** — `.turbo/cache` via `actions/cache`, one key per job and commit, restored from the latest run of
  the same job. For a shared remote cache, set the `TURBO_TOKEN` secret and the `TURBO_TEAM` variable; nothing
  else changes.
- **uv** — `astral-sh/setup-uv` caches downloads keyed by `services/intel/uv.lock` (only when it exists).
- **Docker layers** — Buildx `type=gha` cache, one scope per image (`postgres` is shared by `integration` and
  `e2e`).

All of the above is in the composite action `.github/actions/setup`.

## Secrets and permissions

Workflows default to `contents: read`. Only `publish` gets `packages: write` (GHCR, via the built-in
`GITHUB_TOKEN`); CodeQL gets `security-events: write`. No repository secrets are required. The optional
`TURBO_TOKEN` only enables the remote cache. Checkouts use `persist-credentials: false`.

## Pinned actions

Every third-party action is pinned by full commit SHA with the version in a comment
(`uses: actions/checkout@<sha> # v7.0.1`). Renovate updates the SHA and the comment together
(`helpers:pinGitHubActionDigestsToSemver`). To update one by hand:

```bash
gh api repos/<owner>/<action>/commits/<tag> --jq .sha      # or: git ls-remote https://github.com/<owner>/<action> <tag>
```

Lint workflow changes with [actionlint](https://github.com/rhysd/actionlint) (it also runs shellcheck on `run:`
blocks): `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12`. Running jobs locally with
[`act`](https://github.com/nektos/act) is possible but optional (no Docker-in-Docker for Testcontainers).

## Adding a container image

1. Write the Dockerfile (Node apps: `infra/docker/<app>/Dockerfile`, multi-stage with `turbo prune --docker`
   in the first stage, built from the repo root).
2. Add or adjust its entry in `infra/docker/images.json` (`name`, `dockerfile`, `context`). Entries for future
   images may already be there; they are skipped until the Dockerfile exists.
3. Pin base images by digest. On the next push to `main`, `publish (<name>)` pushes
   `ghcr.io/<owner>/bf-<name>:<sha>` and `:main`.
4. Images run as a non-root user with a `HEALTHCHECK`, contain no secrets, and read every URL and key from the
   environment at run time (the web image too: `apps/web/src/lib/public-env.ts`), so one image serves staging and
   production. Deployed images: `api` (roles `http`, `worker`, `migrate`, package scripts), `web`, `intel`,
   `postgres`, `caddy` (with the DNS-01 module), `backup`.

## Dependency updates

[Renovate](https://docs.renovatebot.com/) (`renovate.json`), chosen over Dependabot because it understands pnpm
catalogs, `uv.lock` and Docker digests, and groups updates in one PR per area. Weekly (Monday morning,
St-Barthélemy time), grouped (GitHub Actions, Docker base images, intel Python, NestJS, OpenTelemetry,
Next/React, testing, lint), lockfile maintenance monthly; patch updates of dev dependencies merge
automatically once CI passes. TypeScript stays below 7 (DECISION(BF-001)). Renovate needs the
[Renovate GitHub App](https://github.com/apps/renovate) installed on the repository (owner action).
