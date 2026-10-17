# Production environment (BF-061)

Production has the same shape as staging (ADR-0014: one VPS, Docker Compose, Caddy, GHCR images), so set it up with
[staging-setup.md](staging-setup.md) §1–§5 and these differences. Day-to-day operation: [deploy.md](deploy.md),
[rollback.md](rollback.md).

## 1. Topology

**Decision (BF-061): one VPS at launch (VPS-1, "core"), with the generation host as the first scaling step.**

| Host | Runs | When |
|---|---|---|
| VPS-1 (core) | Caddy, web, sites, api, worker, intel, Postgres 17 (PostGIS, pgvector), Valkey, backup, the observability stack | launch |
| VPS-2 (generation) | a worker for the generation queues only, agent-runner sandboxes, the egress proxy, the sandbox broker (BF-060) | when sandbox load competes with the database (see [capacity](#5-capacity)) or once BF-060's broker ships |

On one host, Postgres is protected from the heavy workloads by the compose resource limits (`deploy.resources.limits`
on every service: the worker 1.5 CPU / 1.25 GB, intel and the sandboxes capped, Postgres 2 CPU / 2.5 GB with
`shared_buffers` sized from it) and by the sandbox concurrency limit (`GENERATION_MAX_SANDBOXES`, default 4, with `SANDBOX_CPUS` / `SANDBOX_MEMORY_MB` per sandbox, BF-043). Size
VPS-1 at 8 vCPU / 16 GB minimum ([agent-runner-sizing.md](agent-runner-sizing.md)).

Terraform/Ansible: **not used**. One host provisioned once by the documented steps (staging-setup.md §1) is cheaper to
keep correct than a provisioning codebase; revisit when there is a second host.

## 2. DNS

As staging (`app.`, `api.`, `u.`, `*.sites` wildcard, the ACME DNS-01 token for the wildcard), plus:

- **CAA**: `CAA 0 issue "letsencrypt.org"` and `CAA 0 issuewild "letsencrypt.org"` on the base and sites domains,
  `CAA 0 iodef "mailto:<ops address>"`. Custom client domains (BF-062) carry their own CAA, if any.
- **Sending domains**: SPF, DKIM (published by the mailbox provider) and DMARC per sending domain; the
  deliverability page (BF-056) checks them.
- `cname.<sites domain>` → VPS-1 (custom domains' CNAME target), and `SITES_INGRESS_IPS` = VPS-1's addresses.

## 3. GitHub configuration

- **Environment `production`** (Settings → Environments): *required reviewers* (at least one person other than the
  one who starts the deploy), deployment branches: `main` only. Secrets `PRODUCTION_HOST`, `PRODUCTION_USER`,
  `PRODUCTION_SSH_KEY`, `PRODUCTION_KNOWN_HOSTS`; variables `PRODUCTION_BASE_DOMAIN` and, optionally,
  `PRODUCTION_CANARY_URL` (a preview site kept published for the smoke test).
- The deploy key's forced command is the same `infra/deploy/ssh-command.sh` as staging (`current`, `previous`,
  `upload`, `login`, `logout`, `deploy`, `rollback`). Reinstall it on the server whenever that file changes.
- Workflows: `release.yml` (release PR, tags, image pinning), `deploy-production.yml` (manual, approved).

## 4. Differences from staging in `/opt/bf`

- `.env`: no `IMAGE_TAG` (deploys pass the release version); the infrastructure images (`POSTGRES_IMAGE_TAG`,
  `CADDY_IMAGE_TAG`, `BACKUP_IMAGE_TAG`) are bumped on purpose, never by a release.
- `releases/vX.Y.Z/release.env` arrives with each deploy: the application images by digest. The server never
  pulls a mutable tag in production.
- `app.env`: `NODE_ENV=production`, `SIGNUP_MODE=invite_only` (BF-062: `open` refuses to boot without
  `FEATURE_SELF_SERVE_SIGNUP=true`), real provider keys, and `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at the observability
  stack's collector (part 3 of BF-061).

## 5. Capacity

Move a workload off VPS-1 when, over a week:

- Postgres CPU steal or `node_load5 / cores > 0.8` at business hours, or p95 query latency doubles → VPS-2 for
  generation first (it is the bursty, CPU-heavy part), then consider a managed Postgres (keep PostGIS/pgvector).
- Disk > 70% → grow the volume; WAL and backups are off-host (object storage), the data directory is not.
- Generation queue age p95 > 30 min with sandboxes at the concurrency cap → VPS-2 (or raise the cap if VPS-1 has
  headroom).

Out of scope for now (documented options): Kubernetes, multi-region, a managed database migration.
