---
id: BF-025
title: Staging deployment (images, compose, Caddy, deploy workflow, runbook)
milestone: M1 Find & List
epic: ops
type: infra
priority: P0
size: M
depends_on: [BF-002, BF-006, BF-007, BF-008, BF-009, BF-010]
blocks: [BF-043, BF-061, BF-062]
areas: [infra, ci]
---

# BF-025 — Staging deployment (images, compose, Caddy, deploy workflow, runbook)

## Context
The sales partner in Saint-Barthélemy should test real features as early as M1. Hosting decision: one US-East VPS with Docker Compose behind Caddy ([ADR-0014](../adr/0014-hosting-vps-compose-caddy.md)). CI already builds and pushes images to GHCR on `main` (BF-009). Apps exist: api/worker, web, intel; `sites` arrives in M3 (compose must accommodate it later without rework).

## Goal
Every merge to `main` deploys automatically to a staging environment at `app.<staging-domain>` / `api.<staging-domain>`, with migrations, health checks, rollback, basic backups and a runbook to set up the server from scratch.

## Scope
**In scope**
- Production-grade Dockerfiles (multi-stage, `turbo prune --docker`, non-root, minimal runtime, healthchecks):
  - `infra/docker/api/Dockerfile` (one image; command selects `http` or `worker`; separate `migrate` command running `pnpm db:migrate` against `DATABASE_URL`).
  - `infra/docker/web/Dockerfile` (Next.js standalone output).
  - Reuse `infra/docker/intel/Dockerfile` (BF-008).
- `infra/compose/docker-compose.prod.yml`: `caddy`, `web`, `api`, `worker`, `intel`, `postgres` (custom image, tuned `shared_buffers`/`work_mem` via env, volume), `valkey` (AOF), `migrate` (one-shot, `depends_on` postgres healthy), optional profiles `scraper`, `verify`; resource limits; restart policies; log rotation (json-file max-size); internal network; only Caddy exposes ports 80/443.
- Caddy:
  - Custom build (`infra/caddy/Dockerfile` with `xcaddy` + the DNS provider module needed for DNS-01 — parameterized; document Cloudflare as the default example).
  - `Caddyfile` template: `app.{$BASE_DOMAIN}` → web, `api.{$BASE_DOMAIN}` → api (SSE-friendly: `flush_interval -1`), `*.{$SITES_BASE_DOMAIN}` → sites (placeholder upstream until BF-036, returns 503 page), security headers (HSTS, nosniff, referrer policy), compression, JSON access logs, `request_body` limits.
- Deploy workflow `.github/workflows/deploy-staging.yml`: on successful CI images for `main` → SSH (secrets: `STAGING_HOST`, `STAGING_USER`, `STAGING_SSH_KEY`; known_hosts pinned) → write `IMAGE_TAG=<sha>` → `docker compose pull` → `docker compose run --rm migrate` → `docker compose up -d --remove-orphans` → wait for `/health/ready` on api and web via Caddy → on failure roll back to previous `IMAGE_TAG` and fail the job; concurrency group `staging`.
- Secrets on server: `/opt/bf/.env` (mode 600, owned by deploy user) created from `.env.example` with production values; documented list of required secrets (link `docs/ENVIRONMENT.md`).
- Staging backups: nightly `pg_dump` (custom format) via a small `backup` container/cron to S3-compatible storage with 14-day retention (prod-grade PITR is BF-061); restore command documented and tested once.
- Runbook `docs/runbooks/staging-setup.md`: VPS sizing (4 vCPU / 8 GB RAM / 160 GB SSD to start), region US-East, OS hardening (non-root deploy user, SSH keys only, ufw 22/80/443, fail2ban, unattended upgrades, Docker install from official repo), DNS records (`app`, `api`, wildcard for sites, CAA), first deploy, `pnpm admin:bootstrap` via `docker compose run --rm api admin:bootstrap …`, how to roll back, how to read logs, how to restore a backup.
- Smoke test script `scripts/smoke-staging.mjs` (health, sign-in page loads, API `/v1/system/info`).

**Out of scope**
- Production environment, PITR, monitoring/alerting stack, image digest pinning (→ BF-061). Agent sandbox socket proxy (→ BF-043 adds the service).

## Requirements
### Functional
- Merge to `main` → staging updated within ~10 minutes with migrations applied; failed health → automatic rollback.
- TLS valid for app/api (and wildcard for sites once DNS-01 configured).
### Non-functional
- Images run as non-root; no secrets baked into images; only 80/443/22 open.

## Design
- Image tags: `ghcr.io/<owner>/bf-<image>:<sha>`; compose uses `${IMAGE_TAG}`.
- Migrations always run before app containers update (expand/contract policy keeps old containers compatible during rollout).

## Implementation plan
1. Dockerfiles with pruning; verify image sizes and startup.
2. Prod compose + Caddy build + Caddyfile; test locally with self-signed/local CA (`tls internal`).
3. Deploy workflow with rollback; dry-run against a test VPS if available (or document manual test).
4. Backup container + restore test.
5. Runbook + smoke script.

## Testing
- Local: `docker compose -f infra/compose/docker-compose.prod.yml up` with `tls internal` → app/api reachable through Caddy; SSE works through Caddy (curl -N).
- Workflow: shellcheck for scripts; `act` dry-run optional; first real deploy documented in PR (if a server is available) with logs.

## Acceptance criteria
- [x] Production Dockerfiles for api/worker/migrate, web (and intel reused) — non-root, healthchecks, pruned.
- [x] Prod compose + Caddy (with DNS-01 capable build) + headers; SSE works through the proxy.
- [x] Deploy workflow with migrations, health gate and automatic rollback.
- [x] Nightly staging backups to object storage with documented restore.
- [x] Runbook enables a fresh server setup by following it step by step.

## Implementation notes (BF-025)
- **Images** (`infra/docker/{api,web,backup}`, `infra/caddy`; intel and postgres reused): multi-stage, `turbo prune
  --docker`, bases pinned by digest (the PostGIS base too), non-root users, `HEALTHCHECK`s, per-Dockerfile
  `.dockerignore` (no `.env`/`*.env` anywhere in the context).
  - `api`: one image; entrypoint roles `http` (default), `worker`, `migrate`, or any `apps/api` package script
    (`admin:bootstrap --email …`) run without pnpm. TypeScript runs through `@swc-node/register` as in development,
    so `@bf/tsconfig` became a runtime dependency. 938 MB: better-auth's optional peers (Next, Vitest…) come along —
    follow-up.
  - `web`: Next.js standalone output (`NEXT_OUTPUT=standalone`, set by the Dockerfile only), 277 MB; only
    `.next/cache` is writable. **No URL baked in**: `NEXT_PUBLIC_*` are read by the server at run time (required and
    validated in production) and handed to `<Providers>` (`src/lib/public-env.ts`); one image for staging and
    production. Server-side API calls use the internal network (`API_INTERNAL_URL`) and forward the visitor's
    `X-Forwarded-For`.
- **Compose** (`infra/compose/docker-compose.prod.yml`): caddy, web, api, worker, intel, postgres, valkey (AOF,
  400 MB cap, `noeviction`), backup, one-shot `migrate`, optional `scraper`/`verify` profiles. **Secrets per audience**:
  `.env` (compose variables only), `app.env` (api/worker), `caddy.env` (DNS token), `backup.env`, `intel.env` (its own
  storage key); `web` gets none. `cap_drop: [ALL]` + `no-new-privileges` on the app containers. Networks: `edge`
  (Caddy `.10` and web `.11` fixed, outside the dynamic `ip_range`: the API's only trusted proxies) and an internal
  `data` network. Infrastructure images (postgres, caddy, backup) have their own tags in `.env`, so a release never
  restarts the database. Only Caddy publishes ports.
- **Caddy**: xcaddy build with a DNS module (Cloudflare default); `app.`/`api.` automatic HTTPS, `*.{SITES_BASE_DOMAIN}`
  DNS-01 wildcard with a 503 page until BF-036; headers only where the apps set none; streaming (`flush_interval -1`)
  and no compression for SSE; body limits; JSON logs; `CADDY_TLS=internal` for rehearsals.
- **Deploy**: `deploy-staging.yml` runs on CI success for `main` (or by hand, only from `main`); scripts always come
  from `main`, the image sha must be on `main`, an older build than the deployed one is skipped; the SSH key can only
  run the forced command `infra/deploy/ssh-command.sh` (`current`, `upload <sha>`, `login`, `logout`, `deploy <sha>`);
  the key is deleted before the smoke test. `deploy.sh`: lock, ignores hangups, release directories (`releases/<sha>/`,
  a rollback uses its own compose file), pull → migrate → `up --wait` → health through Caddy → keep (prune older
  releases and images) or roll back; the CI log shows container states only, never logs.
- **Backups** (`bf-backup`): nightly `pg_dump -Fc`, encrypted before upload (rclone crypt), retention only after a
  successful upload; restore requires `--into <db>` or `--overwrite-live` and runs in one transaction. The first
  restore test found `bf_tsvector()` unrestorable under pg_restore's empty `search_path`: **migration 0018** (+ test).
- **Verified locally twice** (second run after the review fixes, fresh volumes, split env files, release directories):
  r1 → r2 (Postgres not restarted) → bootstrap through compose → smoke green with the release check → broken r3 →
  rolled back to r2; SSE events streamed through Caddy (first run); encrypted backup → ciphertext in the bucket →
  restore into a new database with the identical schema.
- **Decision**: separate migration/runtime database roles are BF-060's (the reviewer-suggested `bf_app` role was
  prototyped and dropped: default grants would also give UPDATE/DELETE on the append-only audit log).
- **Not done here**: a deploy to a real server (none available); shellcheck runs locally (official image), not in CI.
- **Follow-ups**: slimmer api image; shellcheck in CI; IPv6 on the edge network; production, PITR and image digests
  (BF-061); runtime DB role (BF-060).

## Agent prompt
```text
Implement BF-025 (Staging deployment).

Read first: AGENTS.md, docs/adr/0014-hosting-vps-compose-caddy.md, docs/ARCHITECTURE.md §3 and §15,
docs/conventions/security.md (headers, secrets), docs/ENVIRONMENT.md (BF-002), docs/CI.md (BF-009).

Rules:
- Verify current Caddy DNS-01 plugin build instructions and Next.js standalone Docker guidance before coding.
- No secrets in images or the repository (this repository is public). Document every required secret instead.
- Rollback must be automatic on failed health checks; test the failure path (e.g. a deliberately broken tag).

Verify: local prod-compose run with `tls internal`; paste curl outputs for app, api health and an SSE stream;
attach image sizes.
```

## References
- ADR-0014 · docs/ARCHITECTURE.md §15
- Caddy: https://caddyserver.com/docs/ · Caddy DNS modules: https://caddyserver.com/docs/modules/ · Next.js self-hosting: https://nextjs.org/docs/app/guides/self-hosting · turbo prune: https://turborepo.com/docs/reference/prune
