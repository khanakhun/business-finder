---
id: BF-061
title: Production environment — releases, zero-downtime deploys, PITR backups and restore drills, monitoring, alerting, SLOs
milestone: M5 Learn & Scale
epic: ops
type: chore
priority: P0
size: L
depends_on: [BF-005, BF-025, BF-043, BF-060]
blocks: []
areas: [infra, ops]
---

# BF-061 — Production environment: releases, zero-downtime deploys, PITR backups and restore drills, monitoring, alerting, SLOs

## Context
Staging (BF-025) proves the deployment shape: one US-East VPS, Docker Compose, Caddy, GHCR images ([ADR-0014](../adr/0014-hosting-vps-compose-caddy.md)). Production must also survive data loss, bad releases and silent failures. The services involved:
- the renderer serving prospects' previews;
- the outbound pipeline sending under the agency's name;
- sandboxes running coding agents;
- costly AI calls.

Observability primitives exist from BF-005 (OTel, pino/structlog, `/metrics`, Langfuse, Sentry hooks). Earlier tickets defined alerts in their scope; this ticket wires them into one operated system.

## Goal
A production environment with:
- tagged, signed releases deployed with health-gated, near-zero-downtime rollouts and one-command rollback;
- Postgres PITR backups with automated restore drills;
- object storage protection;
- a metrics, logs and traces stack with dashboards;
- actionable alerts routed to the team, and SLOs with error budgets;
- an uptime probe for the public surfaces;
- capacity and cost runbooks.

## Scope
**In scope**
- **Topology** (documented in `docs/runbooks/production.md`; Terraform or Ansible optional, evaluate and document):
  - **VPS-1 (core)**: Caddy, web, api, worker (non-sandbox queues), intel, Postgres 17 (PostGIS/pgvector), Valkey.
  - **VPS-2 (generation, optional at launch)**: worker for generation queues + agent-runner sandboxes + egress proxy + sandbox broker (BF-060). This isolates heavy and untrusted workloads from the database host. If launching with one VPS, document the resource limits that protect Postgres.
  - S3-compatible object storage (assets, artifacts, backups) with versioning and lifecycle rules. A separate bucket and credentials for backups (write-only from the DB host, no delete permission).
  - DNS: `app.`, `api.`, `u.` (unsubscribe), `*.sites-domain`, sending domains (records documented; DKIM by mailbox providers), CAA records.
- **Release process**:
  - Conventional commits → changelog (release-please or changesets; choose and document).
  - Tag `vX.Y.Z` → CI builds images, SBOMs, **cosign signatures** (BF-060) → GitHub Release.
  - Production deploy is manual-approval (GitHub Environments with required reviewers).
  - Images are referenced **by digest** in the production compose. Deploy verifies signatures before pulling.
- **Zero-downtime-ish deploys** (Compose on one host):
  - Migrations follow **expand/contract** (enforced by a migration linter: no destructive changes in the same release as code that stops using a column; a checklist in the PR template).
  - Deploy order:
    1. run the `migrate` one-shot;
    2. start new containers side by side (scaling `api`/`web`/`sites` to 2 with distinct names);
    3. Caddy health-checks upstreams;
    4. drain old containers (graceful shutdown: HTTP keep-alive close, SSE reconnect hints, BullMQ worker `close()` waiting for active jobs ≤ 30 s, sandbox runs allowed to finish or be reaped);
    5. remove the old containers.
  - **Rollback** command: redeploy the previous digests; forward-only migrations make rollback safe within the expand/contract window.
  - Post-deploy smoke tests (`scripts/smoke-prod.mjs`: health, sign-in page, API info, a fixture preview site render, unsubscribe page) with automatic rollback on failure.
- **Backups and recovery**:
  - **Postgres PITR**: pgBackRest or WAL-G (choose; document). Continuous WAL archiving to S3, nightly full plus incrementals, retention 30 days of PITR + 12 monthly. Encrypted (repository encryption) and monitored (last successful backup age).
  - **Restore drill**: a monthly automated workflow restores the latest backup into an ephemeral environment (a CI runner or temporary VPS), runs integrity checks (row counts vs metrics, migrations at head, sample queries) and reports. The alert fires if the drill fails or doesn't run. The RPO/RTO targets are documented (RPO ≤ 5 min, RTO ≤ 2 h) and measured by the drill.
  - Valkey: AOF persistence. Valkey is treated as rebuildable (queues are recoverable from DB state machines and the outbox: document and test a "Valkey lost" scenario).
  - Object storage: versioning + lifecycle rules (expire non-current versions after 30 days); a backup bucket replicated to a second provider or region (rclone job; optional but documented).
  - Secrets backup: the master key escrow procedure (offline, two people) is documented.
- **Observability stack** (self-hosted Grafana LGTM-style on VPS-1, or Grafana Cloud free tier; choose and document):
  - Metrics: Prometheus or an Alloy agent scraping `/metrics` (api, worker, sites, intel, Caddy, Postgres exporter, Valkey exporter, node exporter, cAdvisor).
  - Logs: Loki via an agent from Docker JSON logs, with the redaction verified (no secrets or PII). Retention 30 days.
  - Traces: Tempo (OTLP from BF-005), sampling (10% + all errors).
  - LLM: Langfuse (self-hosted container or cloud) with cost dashboards; prompts and payload logging policies respect privacy (no prospect PII in traces beyond ids).
  - Errors: Sentry (DSN-configured) for web, api, worker and sites; source maps uploaded on release.
- **Dashboards** (provisioned as code in `infra/observability/dashboards/*.json`):
  - API RED metrics; queues (depth, age, failures per queue); generation (jobs by engine and outcome, sandbox concurrency, cost); outreach (sends, bounces, pauses, kill switch); renderer (latency, cache hit ratio, 4xx/5xx); Postgres (connections, slow queries, replication/backup status); host resources; LLM spend vs budget.
- **Alerts** (Alertmanager or Grafana alerting → email + Slack/Telegram webhook; documented routing), with a runbook link per alert:
  - API/sites availability (probe failing 2 min);
  - 5xx rate > 2% (5 min);
  - queue backlog age > 10 min (critical queues: `outreach.send`, `system.outbox`);
  - failed-job rate spikes;
  - generation failure rate > 30% (1 h);
  - sandbox count stuck at max (30 min);
  - mailbox auto-pause and kill switch activation (from BF-056);
  - bounce rate thresholds;
  - LLM spend > 80% of the monthly budget;
  - backup age > 26 h or WAL archiving lag > 15 min;
  - restore drill failed;
  - disk > 80%;
  - certificate expiry < 14 days;
  - any `sent` message without a decision (BF-049 audit query).
- **SLOs** (`docs/runbooks/slos.md`), with error-budget burn-rate alerts (multi-window):
  - renderer availability 99.9% monthly, P95 latency < 300 ms;
  - API availability 99.5%;
  - outbound send pipeline: 99% of due messages sent within 10 min of their scheduled slot;
  - generation: 95% of jobs reach a terminal state within 30 min.
- **Uptime probes**: an external probe service (e.g. a hosted uptime checker or a small probe on a different provider) for `app.`, `api./health`, a canary preview site, and the unsubscribe page.
- **Capacity and cost**:
  - Runbook with sizing guidance (when to move Postgres to a managed service; when to add a generation VPS).
  - A monthly infrastructure plus AI cost report (from BF-058 economics + provider invoices; manual input documented).
- **Operational runbooks**: deploy, rollback, restore (full and PITR to timestamp), rotate secrets (links BF-060), Valkey loss, disk full, Postgres bloat/vacuum, stuck queues, sandbox runaway, mailbox compromise, sending-domain blocklisting, certificate issues.

**Out of scope**
- Kubernetes, multi-region active-active, a managed database migration (documented as a future option).

## Requirements
### Functional
- A failed deploy auto-rolls back; a rollback to the previous release takes < 10 minutes.
- The monthly restore drill runs automatically and proves recovery within RTO; failures alert.
- Every alert has an owner, severity and runbook link.
### Non-functional
- Deploys cause no failed requests for the renderer (measured with a load probe during deploy; ≤ 0.1% errors acceptable for API/web).
- Observability overhead < 10% CPU on VPS-1 at typical load.

## Design
```
infra/compose/{docker-compose.prod.yml (digests), docker-compose.observability.yml, docker-compose.generation.yml}
infra/observability/{alloy/*.river or prometheus.yml, loki/*, tempo/*, alerting/rules/*.yml, dashboards/*.json}
infra/backup/{pgbackrest|walg}/*, infra/backup/drill/{restore-drill.sh, checks.sql}
.github/workflows/{release.yml, deploy-production.yml, restore-drill.yml}
scripts/{deploy.sh, rollback.sh, smoke-prod.mjs}
docs/runbooks/{production.md, slos.md, deploy.md, rollback.md, restore.md, …}
```
- Patterns:
  - Immutable infrastructure via digests.
  - Expand/contract migrations.
  - Blue/green-lite on a single host.
  - Observability as code.
  - Error budgets.

## Implementation plan
1. Topology decision (1 vs 2 VPS) and production compose by digests; DNS and TLS (wildcard DNS-01, CAA).
2. Release workflow with signing and SBOMs; production deploy workflow with approval, side-by-side rollout, smoke tests, auto-rollback.
3. PITR backups + monitoring + automated monthly restore drill.
4. Observability stack + dashboards as code + alert rules with runbooks; Sentry releases.
5. SLOs and burn-rate alerts; uptime probes.
6. Runbooks; game day: simulate Valkey loss, a bad deploy and a restore to a timestamp, and record the results.

## Testing
- Deploy workflow tested against a staging clone (blue/green-lite with a load probe: error counts recorded).
- Restore drill executed once manually and once by CI; RPO/RTO measured.
- Alert rules unit-tested (`promtool test rules` or the Grafana equivalent) with synthetic series.
- Game-day report attached (Valkey loss → recovery without message loss or duplicate sends; bad deploy → auto-rollback).

## Acceptance criteria
- [ ] Signed, tagged releases deployed by digest with manual approval, side-by-side rollout, smoke tests and auto-rollback.
- [ ] Postgres PITR with monitored backups and an automated monthly restore drill meeting RPO ≤ 5 min / RTO ≤ 2 h.
- [ ] Metrics, logs and traces stack with dashboards and alert rules as code; Sentry releases; Langfuse cost views.
- [ ] SLOs with burn-rate alerts; external uptime probes.
- [ ] Runbooks for deploy, rollback, restore, incidents and capacity; game-day report.

## Agent prompt
```text
Implement BF-061 (Production environment, backups, observability).

Read first: AGENTS.md, docs/adr/0014 and 0015, docs/ARCHITECTURE.md §14–§15, BF-025 (staging), BF-005 (observability),
BF-043 (sandbox host requirements), BF-060 (signing, broker, security gates). Skim BF-049/BF-052/BF-056 for alerts they
define.

Rules:
- Everything as code (compose, dashboards, alerts, workflows); production references images by digest.
- Backups are only real if restores are tested: automate the drill and alert on failure.
- Migrations follow expand/contract; deploys are health-gated with automatic rollback.
- Alerts must be actionable: owner, severity, runbook link; avoid noisy alerts.
- Verify current versions and configuration syntax of the chosen tools (pgBackRest/WAL-G, Grafana Alloy/Prometheus,
  Loki, Tempo) before writing configs.

Verify: workflows green on a staging clone; restore drill report; game-day report; pnpm verify for scripts.
```

## References
- ADR-0014 · ADR-0015 · docs/ARCHITECTURE.md §14–§15 · BF-025
- pgBackRest: https://pgbackrest.org/ · WAL-G: https://github.com/wal-g/wal-g · Grafana Alloy: https://grafana.com/docs/alloy/latest/ · Loki: https://grafana.com/docs/loki/latest/ · Tempo: https://grafana.com/docs/tempo/latest/ · Google SRE workbook (SLO alerting): https://sre.google/workbook/alerting-on-slos/ · Sigstore cosign: https://docs.sigstore.dev/
