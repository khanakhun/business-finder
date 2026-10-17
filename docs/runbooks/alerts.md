# Alert runbook (BF-061)

One section per Prometheus alert in `infra/observability/alerts/*.rules.yml`. Every alert's `runbook_url` points at
its section here (the anchor is the alert name in lower case), so keep the headings exactly equal to the alert names.

## How to read this page

**Severities** (the `severity` label, routed by `infra/observability/alertmanager/alertmanager.yml`):

| Severity | Means | Delivery |
|---|---|---|
| `page` | act now, at any hour | e-mail + chat webhook, repeated hourly until resolved |
| `warn` | today | e-mail, repeated every 4 h |
| `ticket` | this week | e-mail, once a day |

**Owners** (the `owner` label): `ops`, `outreach`, `generation`, `compliance`, `analytics`. Everyone is one team today;
Alertmanager groups by `alertname` and `owner` and sends every owner to the same receivers. The label says who should
take the lead once the team grows.

**Where to look first** — Grafana at `https://grafana.<domain>` (folder *Business Finder*):

| Dashboard | For |
|---|---|
| SLOs and error budgets | the burn-rate alerts, availability over 30 days |
| API (RED) | 5xx ratio, latency, slowest routes, routes returning 5xx |
| Queues and the outbox | waiting jobs, oldest waiting job, failed jobs, outbox backlog |
| Generation and sandboxes | jobs by engine and outcome, sandboxes, quality decisions, sandbox runs |
| Outreach | messages by status, due → attempt, kill switch, bounce rate, automatic pauses, sends without a decision |
| Renderer and public surfaces | probe success and duration, certificate expiry, Caddy codes and latency |
| Postgres and backups | connections, last full backup, WAL in the spool, last restore drill |
| Host and containers | CPU, memory, disk, load, per-container CPU and memory |
| AI spend | spend this month per workspace, generation and quality gates cost |

Logs are in Loki (Grafana → Explore), labelled by compose `service` (`api`, `worker`, `sites`, `web`, `caddy`,
`postgres`, `valkey`, `pgbackrest`, `intel`, …): `{service="worker"} |= "analytics refresh failed"`. A log line
carries a `traceId`; paste it into Tempo (Explore → Tempo → TraceQL or the trace id field) to see the whole request.
Every trace with an error is kept for 14 days.

**Server commands.** Everything runs in `/opt/bf` as the deploy user. The application stack is the compose project
`bf`; the commands below use `docker compose -p bf …` as shorthand for the full invocation (the `dc` alias from
[staging-setup.md](staging-setup.md): `docker compose -p bf --project-directory /opt/bf --env-file /opt/bf/.env -f
/opt/bf/releases/<version>/docker-compose.prod.yml`). The observability stack is its own project in
`/opt/bf/observability`: `docker compose -p bf-obs -f docker-compose.observability.yml --env-file ../.env …`.

**Never paste container logs into a public place** (issues, chats, PRs): Caddy's access logs hold visitors' addresses
and full URLs (one-time links included), and the API and worker logs can hold prospect identifiers. Read them on the
server, quote the line you need with the identifiers removed.

Related runbooks: [deploy.md](deploy.md), [rollback.md](rollback.md), [restore.md](restore.md),
[generation-quality.md](generation-quality.md), [production.md](production.md) (capacity in §5),
[agent-runner-sizing.md](agent-runner-sizing.md), [secrets-rotation.md](secrets-rotation.md),
[observability.md](observability.md), [slos.md](slos.md), and for outreach
[../compliance/outreach-compliance.md](../compliance/outreach-compliance.md).

---

## availability (`platform.rules.yml`)

### PublicSurfaceDown

`page`, owner `ops`. `probe_success{job="blackbox-http"} == 0` for 2 minutes: one of the synthetic probes fails. The
`probe` label says which: `app` (`https://app.<domain>/health/ready`), `api` (`https://api.<domain>/health/ready`),
`unsubscribe` (`https://u.<domain>/u/…`, any HTML page counts) or `canary` (the preview at `CANARY_URL`). The probe goes
out through DNS and TLS like a visitor.

**Impact.** Users cannot use that surface; `unsubscribe` down means recipients cannot opt out (a compliance problem,
see [outreach-compliance.md §2](../compliance/outreach-compliance.md)); `canary` down means every preview is down.

**First checks.**
- *Renderer and public surfaces* → *Probe success* and *Probe duration*: one probe or all of them? All of them points at Caddy, DNS or the host.
- From your machine: `curl -sS -o /dev/null -w '%{http_code}\n' https://api.example.com/health/ready`.
- `docker compose -p bf ps` — is `caddy`, `api`, `web` or `sites` restarting or unhealthy?
- `docker compose -p bf logs --since 15m caddy` (on the server only), `… logs --since 15m api`.
- Did a deploy just happen? `cat /opt/bf/IMAGE_TAG` and the deploy-production workflow run.

**Fix.** A bad release: [rollback.md](rollback.md). A container crash-looping on configuration: `docker compose -p bf logs
<service>`, fix `.env` / `app.env`, `docker compose -p bf up -d <service>`. A certificate problem: `docker compose -p bf
logs caddy | grep -i acme` ([staging-setup.md §8](staging-setup.md#8-when-something-is-wrong)). The host itself gone:
the external uptime checks ([slos.md](slos.md)) will say so; restart it at the provider, then `docker compose -p bf up -d`.

### ApiErrorRateHigh

`page`, owner `ops`. Over 2% of API responses are 5xx over 5 minutes (`bf_http_requests_total{job="api",status="5xx"}`),
with at least a trickle of traffic (> 0.05 req/s), for 5 minutes.

**Impact.** The dashboard and the worker's callers see failures; the API SLO (99.5%) burns.

**First checks.**
- *API (RED)* → *Routes returning 5xx* and *Slowest routes (p95)*: one route or everything?
- Loki: `{service="api"} |= "statusCode\":5"` or simply `{service="api"} |= "error"`, then open a `traceId` in Tempo.
- `docker compose -p bf ps api` — two replicas during a rollout is normal; a restart loop is not.
- *Postgres and backups* → *Connections*: is the pool exhausted? *Host and containers*: memory pressure on `api`?
- Did a release go out in the last hour (`cat /opt/bf/IMAGE_TAG`, the workflow run)?

**Fix.** Errors started with a release → [rollback.md](rollback.md) (under 10 minutes), then fix forward. One route
only → a bug or an upstream (provider, intel) failure: check `{service="intel"}` and the provider's status, apply the
circuit-breaker fallbacks. Database or Valkey trouble → see [PostgresDown](#postgresdown) / [ValkeyDown](#valkeydown).

### ScrapeTargetDown

`warn`, owner `ops`. Prometheus cannot scrape a target (`up == 0`) for 5 minutes; the `job` label names it (`api`,
`worker`, `intel`, `caddy`, `node`, `cadvisor`, `postgres`, `valkey`, `observability`). The blackbox probes are excluded
(they have their own alert).

**Impact.** Blind spot: the alerts that read that target cannot fire. Often the service is fine and only its
`/metrics` endpoint or the exporter is down — but `worker` or `api` down is a real outage.

**First checks.**
- Prometheus → Status → Targets (reach it from a container on the `obs` network, or port-forward over SSH) for the error text.
- `docker compose -p bf ps` for an application target; `docker compose -p bf-obs -f docker-compose.observability.yml --env-file ../.env ps` for an exporter.
- `job="worker"`: the worker exports on port 9464; a missing runner image keeps `/health/ready` failing but not `/metrics`.
- `job="postgres"` / `job="valkey"`: the exporters join `bf_data`; check the `bf_monitor` role and `pg_monitor_password` ([observability.md §2](observability.md#2-the-postgres-monitoring-role)).

**Fix.** Restart the target (`docker compose -p bf up -d <service>` or the same for `bf-obs`); if the service was
renamed or re-networked by a deploy, update `infra/observability/prometheus/prometheus.yml` and reload Prometheus
([observability.md §1](observability.md#1-install-and-update)).

### PostgresDown

`page`, owner `ops`. `pg_up == 0` for 2 minutes: the Postgres exporter cannot connect.

**Impact.** Everything stops: the API returns 5xx, the worker's jobs fail, the renderer (read-only role) 500s. Expect
[ApiErrorRateHigh](#apierrorratehigh), [PublicSurfaceDown](#publicsurfacedown) and queue alerts right after.

**First checks.**
- `docker compose -p bf ps postgres` and `docker compose -p bf logs --since 30m postgres` (OOM kill, a full disk, a failed start after a config change such as `PG_ARCHIVE_MODE`).
- `df -h` on the host and the *Host and containers* dashboard: a full data volume stops Postgres cold.
- Is only the exporter broken? `docker compose -p bf exec postgres pg_isready` — if that passes, it is the monitoring role or password ([observability.md §2](observability.md#2-the-postgres-monitoring-role)), not Postgres.
- *Postgres and backups* → *Connections* right before the drop (too many connections?).

**Fix.** `docker compose -p bf up -d postgres` after fixing the cause; a full disk → [DiskAlmostFull](#diskalmostfull).
Corrupted or lost data → [restore.md §4](restore.md#4-restoring-production) (stop the writers first). After any
restart, check the worker reconnects (`docker compose -p bf logs --since 5m worker`) and the queues drain.

### ValkeyDown

`page`, owner `ops`. `redis_up == 0` for 2 minutes: the Valkey exporter cannot connect.

**Impact.** Queues, caches, rate limits, locks and the realtime fan-out stop; the API still answers reads but every
job (sends, generation, events) waits. No data is lost that cannot be rebuilt ([restore.md §5](restore.md#5-valkey-lost)).

**First checks.**
- `docker compose -p bf ps valkey`, `docker compose -p bf logs --since 30m valkey` (OOM at `maxmemory`, AOF rewrite failure, a full volume).
- *Host and containers* → *Container memory* for `valkey`.
- `docker compose -p bf exec valkey valkey-cli ping` — `PONG` means only the exporter is broken.
- Queue alerts in the same minutes ([CriticalQueueBacklog](#criticalqueuebacklog)) confirm the workers lost it.

**Fix.** `docker compose -p bf up -d valkey`; an empty volume is acceptable (the outbox relay, the outreach tick and
the scheduled jobs rebuild the queues). Then `docker compose -p bf restart worker api` as
[restore.md §5](restore.md#5-valkey-lost) says, and watch *Queues and the outbox* return to normal within 15 minutes.

### CertificateExpiringSoon

`warn`, owner `ops`. The certificate a blackbox probe sees (`probe_ssl_earliest_cert_expiry`) expires in under 14 days,
for an hour. Caddy renews at 30 days before expiry, so this means renewal has been failing for two weeks.

**Impact.** None yet; in 14 days the `instance` becomes [PublicSurfaceDown](#publicsurfacedown) with TLS errors for
every visitor and every prospect opening a preview.

**First checks.**
- *Renderer and public surfaces* → *Certificate expiry*: one host or the wildcard (`*.sites.<domain>`)?
- `docker compose -p bf logs caddy | grep -i acme` (on the server): rate limits, DNS-01 token scope, the zone.
- CAA records on the domain still allow `letsencrypt.org` ([production.md §2](production.md#2-dns)).
- A custom client domain (BF-062): its CNAME still points at `cname.<sites domain>`?

**Fix.** Fix the DNS-01 token or the DNS record and `docker compose -p bf restart caddy`; Caddy retries at once. For
a rate-limited account, wait for the window and keep the old certificate serving.

## queues (`platform.rules.yml`)

### CriticalQueueBacklog

`page`, owner `ops`. The oldest waiting job in `outreach-send`, `outreach-tick` or `events`
(`bf_queue_oldest_waiting_age_seconds`) is over 10 minutes old, for 5 minutes. The `queue` label says which.

**Impact.** `outreach-send` / `outreach-tick`: due messages miss their sending slot (the send-pipeline SLO) and
sequences stall. `events`: domain events are not delivered — automations, analytics facts and realtime updates fall
behind.

**First checks.**
- *Queues and the outbox* → *Oldest waiting job* and *Waiting jobs*: one queue or all (all → the worker is down or stuck)?
- `docker compose -p bf ps worker`; `docker compose -p bf logs --since 15m worker` for repeated failures or a stalled lock.
- Is Valkey healthy? ([ValkeyDown](#valkeydown)) Is the worker's `/health/ready` failing (a missing runner image blocks start-up)?
- *Jobs handled by outcome* and *Job duration p95*: are jobs failing fast or running very long?
- A deploy in progress? The worker waits up to 45 s for active jobs; longer than that is not a deploy.

**Fix.** Worker down or stuck: `docker compose -p bf restart worker`. Failing jobs: fix the cause (see
[FailedJobsSpike](#failedjobsspike)); if a provider is down, the sends retry by themselves once it returns. Backlog
from load alone: raise worker concurrency or move generation off the host ([production.md §5](production.md#5-capacity)).

### QueueBacklog

`warn`, owner `ops`. Any other queue (enrichment, generation, analytics, syncs, …) has a job waiting for more than
30 minutes, for 15 minutes.

**Impact.** Slow results for users (searches, enrichments, previews) and a throughput SLO at risk
([GenerationSlow](#generationslow)); nothing is lost.

**First checks.**
- *Queues and the outbox* → *Oldest waiting job* by `queue`, and *Jobs handled by outcome*.
- Generation queue: *Generation and sandboxes* → *Sandboxes* — all slots busy means capacity, not a bug ([SandboxesSaturated](#sandboxessaturated)).
- `docker compose -p bf logs --since 30m worker | grep -i <queue>` for errors, rate limits or provider timeouts.
- *Host and containers*: is the worker at its CPU limit (1.5 CPU)?

**Fix.** Provider rate limits or outages: wait or lower concurrency. Persistent load: capacity
([production.md §5](production.md#5-capacity), [agent-runner-sizing.md](agent-runner-sizing.md)). A stuck job holding
a lock: restart the worker; the reaper fails the attempt over.

### FailedJobsSpike

`warn`, owner `ops`. More than 20 jobs of one queue failed in 15 minutes (`bf_jobs_processed_total{outcome="failed"}`),
for 5 minutes.

**Impact.** Depends on the queue: failed sends are retried from their rows (and surface in the outbox's Failed tab),
failed enrichments leave businesses incomplete, failed generation jobs show as failed previews.

**First checks.**
- *Queues and the outbox* → *Jobs handled by outcome* and *Failed jobs (stored)* for the queue.
- Loki: `{service="worker"} |= "<queue name>" |= "failed"`; take one `traceId` to Tempo for the full stack.
- One error everywhere (a provider key revoked, a quota, a schema change) or many different ones?
- Did a release just go out? Compare the first failure's time with `cat /opt/bf/IMAGE_TAG` and the deploy run.
- Provider status pages (search, e-mail, model APIs) for the queue's dependencies.

**Fix.** A release regression → [rollback.md](rollback.md). A revoked or expired provider key → replace it in the
workspace's settings (never in code or logs; [secrets-rotation.md](secrets-rotation.md) if the master key is the
problem). A provider outage → nothing to do but watch the retries; silence the alert for its duration.

### OutboxBacklog

`warn`, owner `ops`. More than 500 recorded domain events have not been dispatched (`bf_outbox_pending_events`) for
10 minutes: the transactional outbox relay is behind or stopped.

**Impact.** Everything event-driven lags: analytics facts ([AnalyticsIngestLagging](#analyticsingestlagging)),
sequence automations, notifications, realtime updates. Nothing is lost — the outbox is in Postgres.

**First checks.**
- *Queues and the outbox* → *Outbox*: growing steadily (relay stopped) or a burst that drains (a backfill or import)?
- `docker compose -p bf logs --since 30m worker | grep -i outbox` — relay errors, Valkey connection errors.
- The `events` queue in *Oldest waiting job*: if it is also old, the consumer side is the problem ([CriticalQueueBacklog](#criticalqueuebacklog)).
- *Postgres and backups* → *Connections* and *Transactions*: a long-running transaction can hold events invisible.

**Fix.** Restart the worker if the relay stopped; after a Valkey loss the relay re-publishes by itself
([restore.md §5](restore.md#5-valkey-lost)). A genuine burst needs no action beyond watching it drain.

## generation (`platform.rules.yml`)

### GenerationFailureRateHigh

`warn`, owner `generation`. Over 30% of generation jobs in the last hour ended `failed`
(`bf_generation_jobs_total{outcome="failed"}`), with at least 5 jobs, for 10 minutes.

**Impact.** Previews are not produced; users retry and spend more; the generation SLO burns.

**First checks.**
- *Generation and sandboxes* → *Jobs by engine and outcome*: one engine (Claude Code or Codex) or both?
- *Sandbox runs by outcome*: `SANDBOX_OOM`, timeouts or frame errors point at the runner, not the engines ([agent-runner-sizing.md](agent-runner-sizing.md#watch)).
- Loki: `{service="worker"} |= "generation" |= "failed"`; a `traceId` into Tempo shows which phase died.
- The model provider's status and the workspace's remaining AI budget (*AI spend*).
- Did the runner image or `@bf/site-blocks` change in the last release?

**Fix.** Runner/API protocol mismatch (`bf_sandbox_frame_errors_total` rising) → the image and the API are out of
step: redeploy the matching pair or [roll back](rollback.md). OOM → raise `SANDBOX_MEMORY_MB` within the host's
budget. Provider outage or budget exhausted → wait or raise the budget. Quality-gate failures are a different alert:
[generation-quality.md](generation-quality.md).

### SandboxesSaturated

`warn`, owner `generation`. In every 5-minute window of the last 30 minutes some attempt waited for a sandbox slot
(`bf_generation_lease_waits_total`): all `GENERATION_MAX_SANDBOXES` leases were held the whole time, by busy or stuck
runs.

**Impact.** Generation latency climbs ([GenerationSlow](#generationslow)); on one host the sandboxes compete with
Postgres for CPU.

**First checks.**
- *Generation and sandboxes* → *Sandboxes* (leases held) against the cap, and *Job duration p50 / p95*.
- `docker ps --filter label=bf.sandbox=true` on the server: containers older than their wall time plus five minutes are leaks the janitor should remove.
- `docker compose -p bf logs --since 30m worker | grep -i sandbox` for lease or reaper errors.
- *Host and containers* → *Load* and *CPU*: is the host itself at the limit?

**Fix.** Real demand: raise `GENERATION_MAX_SANDBOXES` only if the host has headroom (the rule of thumb in
[agent-runner-sizing.md](agent-runner-sizing.md#host-sizing)), otherwise the generation host VPS-2
([production.md §1 and §5](production.md#5-capacity)). Stuck runs: `docker rm -f` the leaked containers; the reaper
fails their attempts over.

## outreach-safety (`platform.rules.yml`)

### MailboxBounceRateHigh

`warn`, owner `outreach`. A mailbox's bounce rate over its last 50 sends (`bf_outreach_mailbox_bounce_rate`) is above
5% for 30 minutes. The deliverability rules (BF-056) usually pause the mailbox before this fires
([OutreachMailboxAutoPaused](#outreachmailboxautopaused)); this alert catches the ones that keep sending.

**Impact.** Sender reputation: more bounces mean more spam folders for every message from that domain, and
providers can suspend the mailbox. Legally, bouncing addresses must not be contacted again (hard bounces go to the
suppression list by the inbound pipeline).

**First checks.**
- *Outreach* → *Mailbox bounce rate (last 50 sends)* and *Messages by status* for the mailbox.
- Outreach → Deliverability in the dashboard: the mailbox's health, SPF/DKIM/DMARC checks, warming status.
- Were the bounced addresses from one source (an import, one enrichment provider)? Check the recent sends' audit source.
- `docker compose -p bf logs --since 1h worker | grep -i bounce` (on the server) for the bounce classifier's output.

**Fix.** Pause the mailbox from Outreach → Deliverability (or the kill switch for the whole workspace if several
mailboxes are affected), fix the cause (a broken DNS record, an unverified address list → run verification before
re-enrolling), and resume only after the rate drops. Note it for the compliance owner: repeated bounces to the same
addresses are a data-quality problem under the minimization principle
([outreach-compliance.md §1](../compliance/outreach-compliance.md#1-seeded-jurisdiction-policies-b2b-email)).

### SendWithoutComplianceDecision

`page`, owner `compliance`. `bf_compliance_sends_without_decision{kind}` > 0: the worker's 10-minute audit found
outbound messages that are `sent`, `bounced` or `replied` without both their enqueue and send decisions
(`kind="email"`), or manual contact logs without a decision (`kind="manual"`). Database check constraints forbid both,
so a migration, a manual data fix or a restore weakened the compliance gate.

**Impact.** A prospect was contacted without a recorded lawful basis: this is the one invariant the product must
never break ([outreach-compliance.md §3](../compliance/outreach-compliance.md#3-system-invariants-enforced-in-code-and-tests)).

**First checks (in this order).**
1. **Stop outbound first**: turn on the workspace kill switch (Outreach → Deliverability, `PUT /v1/deliverability/kill-switch`) for every affected workspace — or all of them if unsure. Do not wait for the diagnosis.
2. *Outreach* → *Sends without a decision*: when did it start? Match the time with the last deploy (`cat /opt/bf/IMAGE_TAG`), the last migration and any manual SQL on the server (shell history, the incident notes).
3. **Preserve evidence**: `docker compose -p bf exec postgres pg_dump …` of `outbound_messages` and `manual_contact_logs` (the affected ids, decisions, timestamps) into the backups bucket — not into a chat. Keep the logs on the server.
4. Inform the compliance owner and record an incident note (what, when, how many recipients, which jurisdictions).

**Fix.** Restore the check constraints (a new migration, reviewed), re-run the audit sampler by restarting the worker,
and only then turn the kill switch off. If a point-in-time restore caused it, see
[restore.md §4](restore.md#4-restoring-production) on what the window lost. The affected recipients may need a
notification depending on the jurisdiction: the compliance owner decides, not ops.

## costs (`platform.rules.yml`)

### AiSpendNearBudget

`warn`, owner `ops`. A workspace's AI spend this month (`bf_ai_spend_month_usd{organization}`) is over 80% of the hard
monthly budget (`bf_ai_budget_month_usd{level="hard"}`, `AI_BUDGET_MONTHLY_HARD_USD`), for 15 minutes. The soft budget
(`AI_BUDGET_MONTHLY_SOFT_USD`) only notifies; the hard one makes the platform refuse new AI calls.

**Impact.** When the hard budget is reached, generation, quality gates, drafting and classification stop for that
workspace until the month rolls over or the budget is raised. Nothing breaks, but previews stop appearing.

**First checks.**
- *AI spend* → *Spend this month per workspace*, *Generation cost (per hour)*, *Quality gates cost (per hour)*: a steady climb or a burst?
- A burst: *Generation and sandboxes* → *Cost per job p50 / p95* and the repair loop (at most two repairs per version: [generation-quality.md](generation-quality.md)).
- Langfuse (spans only in production) for the most expensive traces of the day.
- Is one job retrying in a loop? `{service="worker"} |= "generation" |= "retry"`.

**Fix.** A runaway loop → stop the job, fix, then consider a per-run budget. Legitimate growth → raise
`AI_BUDGET_MONTHLY_HARD_USD` (and soft) in `app.env` and `docker compose -p bf up -d api worker`; note the change in
the incident log. Costs are configuration, not constants (AGENTS.md §6).

## host (`platform.rules.yml`)

### DiskFillingUp

`warn`, owner `ops`. A real filesystem (tmpfs, overlay and `/boot`, `/run` excluded) is over 80% full for 15 minutes.
The `mountpoint` label says which.

**Impact.** None yet; at 90% [DiskAlmostFull](#diskalmostfull) pages, and at 100% Postgres, Loki and the Docker daemon
stop.

**First checks.**
- *Host and containers* → *Disk used*: the slope tells you how long you have.
- `df -h` and `docker system df` on the host; `du -sh /var/lib/docker/volumes/*` for the biggest volumes.
- Usual suspects: old images after many deploys, the WAL spool when pushes fail ([WalArchivingLagging](#walarchivinglagging)), container log files, Loki or Tempo data, the Postgres data directory.
- *Postgres and backups* → *Database size* and *WAL waiting in the spool*.

**Fix.** `docker image prune -a --filter until=168h` (keeps the current and previous releases' images, which are
in use); `docker builder prune`. A growing WAL spool: fix the push first. Over 70% for good: grow the volume
([production.md §5](production.md#5-capacity)).

### DiskAlmostFull

`page`, owner `ops`. A real filesystem is over 90% full for 5 minutes. This alert silences
[DiskFillingUp](#diskfillingup) for the same mountpoint.

**Impact.** Minutes to hours from a hard stop: Postgres refuses writes, Valkey's AOF fails, containers cannot start,
Loki stops ingesting. The API and worker fall over soon after.

**First checks.**
- `df -h`; `docker system df`; `du -sh /var/lib/docker/volumes/* 2>/dev/null | sort -h | tail`.
- `docker compose -p bf ps` — is anything already failing?
- `docker compose -p bf exec pgbackrest bf-pgbackrest info` and `bf_wal_spool_files` — a stuck WAL push fills the spool fast.

**Fix.** Free space now: `docker image prune -a --filter until=168h`, `docker builder prune -a`, truncate rotated
container logs under `/var/lib/docker/containers/*/` if they are large, then grow the volume at the provider
([production.md §5](production.md#5-capacity)). If Postgres already stopped, see [PostgresDown](#postgresdown); never
delete anything under the Postgres data directory or the WAL spool by hand.

## backups (`platform.rules.yml`)

### BackupTooOld

`page`, owner `ops`. No successful full backup in repo1 for 26 hours
(`bf_backup_last_success_timestamp_seconds{repo="1",type="full"}`). The nightly full runs at `BACKUP_AT`.

**Impact.** PITR still works from the last full backup plus WAL, but each missed night lengthens a restore and
shortens the 30-day retention window; two misses mean the WAL chain is the only copy of a day's data.

**First checks.**
- *Postgres and backups* → *Last full backup*.
- `docker compose -p bf ps pgbackrest` (it needs `COMPOSE_PROFILES=pitr`); `docker compose -p bf logs --since 24h pgbackrest`.
- `docker compose -p bf exec pgbackrest bf-pgbackrest info` for the repository state and the last error.
- Object storage reachable from the host (keys in `pgbackrest.env` valid, bucket not full, endpoint up)?
- Enough disk for the backup's temporary files ([DiskFillingUp](#diskfillingup))?

**Fix.** Fix the cause, then take a full backup by hand: `docker compose -p bf exec pgbackrest bf-pgbackrest full`.
Configuration lives in [restore.md §1](restore.md#1-what-is-backed-up); monitoring in [§2](restore.md#2-monitoring).

### WalArchivingLagging

`page`, owner `ops`. WAL segments wait in the spool (`bf_wal_spool_files > 0`) and none has been pushed to the
repositories for 15 minutes (`bf_wal_last_push_timestamp_seconds`). The RPO target is 5 minutes; this is already
three times that.

**Impact.** Every minute without a push is data a restore cannot reach; the spool also grows on the data volume
([DiskFillingUp](#diskfillingup)).

**First checks.**
- *Postgres and backups* → *WAL waiting in the spool*: how many files, how fast does it grow?
- `docker compose -p bf logs --since 30m pgbackrest` — push errors name the repository and the reason (credentials, endpoint, bucket policy, TLS).
- `docker compose -p bf exec pgbackrest bf-pgbackrest info`: `archive` min/max per repository.
- Egress from the host to the object storage endpoint (`curl -sS -o /dev/null -w '%{http_code}\n' https://<endpoint>`).
- Postgres itself still archiving? `docker compose -p bf logs --since 30m postgres | grep -i archive`.

**Fix.** Credentials or endpoint → correct `pgbackrest.env` (mode 600, never committed) and `docker compose -p bf up
-d pgbackrest`; the spool drains by itself. If one repository is down (repo2 at a second provider), the push to
repo1 still protects RPO; note it and fix repo2 today. A stanza problem → [BackupStanzaUnhealthy](#backupstanzaunhealthy).

### BackupStanzaUnhealthy

`page`, owner `ops`. `bf_backup_stanza_ok == 0` for 30 minutes: `pgbackrest check` fails for the stanza `bf`
(repository unreachable, archive mismatch, a cipher passphrase that does not open the repository, a Postgres
version or system id that changed).

**Impact.** Backups and WAL pushes stop or cannot be trusted; a restore may not be possible from this repository.

**First checks.**
- `docker compose -p bf exec pgbackrest bf-pgbackrest info` and `docker compose -p bf logs --since 1h pgbackrest`.
- Did Postgres get re-initialised or restored ([restore.md §4](restore.md#4-restoring-production) step 6: a promoted server starts a new timeline and needs a full backup right away)?
- Was the `POSTGRES_IMAGE_TAG` bumped (a major upgrade changes the stanza's expectations)?
- `pgbackrest.env` unchanged since the last good check (`stat -c %y /opt/bf/pgbackrest.env`)?

**Fix.** After a restore or a major upgrade: `docker compose -p bf exec pgbackrest bf-pgbackrest full` (a fresh
full backup on the new timeline) and re-run the check. Wrong passphrase: the right one is in the password manager
([restore.md §1](restore.md#1-what-is-backed-up)) — never try to rotate it; a repository encrypted with a lost
passphrase is lost. Repository unreachable: as [WalArchivingLagging](#walarchivinglagging).

### BackupMonitoringSilent

`page`, owner `ops`. The `pgbackrest` service writes its metrics file every 5 minutes; nothing for 30 minutes (or the
series is absent) means it stopped — and with it the backups and the WAL pushes.

**Impact.** No backups, no WAL archiving, and no other backup alert can fire. Treat it as
[WalArchivingLagging](#walarchivinglagging) until proven otherwise.

**First checks.**
- `docker compose -p bf ps pgbackrest` — not listed at all means `COMPOSE_PROFILES=pitr` is missing from `.env` (a deploy with the wrong `.env`?).
- `docker compose -p bf logs --since 1h pgbackrest`.
- The textfile path: `node-exporter` reads the `bf_metrics-textfile` volume; `docker compose -p bf-obs -f docker-compose.observability.yml --env-file ../.env ps node-exporter` and `ls -l` the volume's `bf_pgbackrest.prom`.
- Is the whole observability stack silent ([ScrapeTargetDown](#scrapetargetdown) for `job="node"`)?

**Fix.** `docker compose -p bf up -d pgbackrest` (after restoring `COMPOSE_PROFILES=pitr` if it was lost); check
`bf_backup_stanza_ok` returns, then `bf-pgbackrest info`. If only the textfile pipeline broke, restart `node-exporter`
in `bf-obs`.

### RestoreDrillStale

`ticket`, owner `ops`. No successful restore drill for 35 days (`bf_restore_drill_last_success_timestamp_seconds`).
The drill runs on the 3rd of each month (`restore-drill.yml`) and proves RPO and RTO.

**Impact.** Backups are untested: the RTO target (2 hours) is a guess until the next drill passes.

**First checks.**
- GitHub Actions → *restore-drill*: did it run, fail, or was it skipped (secrets missing, runner out of space)?
- The job summary of the last run (RTO, RPO, counts) and `drills/latest.json` in repo1.
- *Postgres and backups* → *Last restore drill* and *Drill RTO*.
- Did the drill fail on `checks.sql` (migrations not at head, a table that no longer scans)? That is a real finding, not a drill problem.

**Fix.** Run the workflow by hand (optionally to a point in time); if it keeps failing, run
`infra/backup/drill/restore-drill.sh` on any Docker host as [restore.md §3](restore.md#3-the-restore-drill) describes
and open an issue with the report (no data, only the counts and timings).

## slo-burn (`slo.rules.yml`)

### ApiErrorBudgetBurnFast

`page`, owner `ops`. The API's 5xx ratio over both the last hour and the last 5 minutes is above 14.4 × 0.5% (7.2%):
at this rate 2% of the 30-day error budget goes in an hour. This alert silences
[ApiErrorBudgetBurnSlow](#apierrorbudgetburnslow).

**Impact.** A serious outage in progress; the monthly 99.5% target is at risk within hours.

**First checks.**
- *SLOs and error budgets* → *API error ratio* and *API availability (30 d)*: how much budget is left?
- Then exactly as [ApiErrorRateHigh](#apierrorratehigh): *API (RED)* → *Routes returning 5xx*, `{service="api"} |= "error"`, a `traceId` into Tempo, `docker compose -p bf ps`.
- A release in the last hour (`cat /opt/bf/IMAGE_TAG`)?

**Fix.** [Roll back](rollback.md) first when a release is the likely cause, diagnose after. When the budget is spent,
the error budget policy applies ([slos.md](slos.md)): no feature releases for the API until the window recovers.

### ApiErrorBudgetBurnSlow

`ticket`, owner `ops`. The API's 5xx ratio over both the last 6 hours and the last 30 minutes is above 6 × 0.5% (3%):
a slow leak that would spend the month's budget in five days.

**Impact.** Not an outage, but the budget is draining; left alone it ends feature releases for the API this month.

**First checks.**
- *SLOs and error budgets* → *API error ratio* over 7 days: since when?
- *API (RED)* → *Routes returning 5xx*: usually one route or one dependency (intel, a provider, a slow query).
- Loki: `{service="api"} |= "error"` over 6 hours, grouped by message; a few `traceId`s into Tempo.
- *Postgres and backups* → *Connections* / *Transactions*: contention at business hours?

**Fix.** Fix the route or the dependency as a normal ticket this week; a bad release that slipped through →
[rollback.md](rollback.md). Budget already spent → [slos.md](slos.md) error budget policy.

### RendererErrorBudgetBurnFast

`page`, owner `ops`. The canary preview probe (`probe_success{probe="canary"}`) fails more than 14.4 × 0.1% (1.44%) of
the time over both the last hour and the last 5 minutes: the renderer or its edge is failing for prospects.

**Impact.** Previews (the product's output) are not reachable; the renderer's 99.9% target burns fast. Outreach
e-mails link to these previews.

**First checks.**
- *Renderer and public surfaces* → *Probe success* for `canary`, and *4xx / 5xx at the edge* and *Edge latency p95 (Caddy)*.
- `docker compose -p bf ps sites`; `docker compose -p bf logs --since 15m sites` (on the server).
- The read-only DB role still works? A 5xx with a Postgres error points at it ([PostgresDown](#postgresdown)).
- The canary preview itself: is it still published (`CANARY_URL`)? A deleted or unpublished canary is a false alarm — republish it or set a new `CANARY_URL` and restart Prometheus.
- A release in the last hour?

**Fix.** A release regression → [rollback.md](rollback.md) (sites rolls out side by side; a rollback is quick). A
Caddy or certificate problem → [PublicSurfaceDown](#publicsurfacedown). Budget spent → [slos.md](slos.md).

### RendererErrorBudgetBurnSlow

`ticket`, owner `ops`. The canary probe fails more than 6 × 0.1% (0.6%) of the time over both the last 6 hours and
the last 30 minutes.

**Impact.** Intermittent preview failures that prospects may hit; the budget drains over days.

**First checks.**
- *Renderer and public surfaces* → *Probe success* and *Probe duration* over 24 hours: a pattern (deploy windows, a nightly job, backup time at `BACKUP_AT`)?
- *Host and containers* → *CPU* and *Load* at the same times: the sandboxes or a backup starving `sites`?
- `docker compose -p bf logs --since 6h sites | grep -iv "GET "` for errors (on the server).
- Probe failures during deploys only: expected for a few seconds; longer means the side-by-side rollout did not hand over cleanly ([deploy.md](deploy.md)).

**Fix.** Resource contention → limits or the generation host ([production.md §5](production.md#5-capacity)).
Deploy-time failures → fix the health gate or the drain timing in `deploy.sh`. Budget spent → [slos.md](slos.md).

### RendererSlow

`warn`, owner `ops`. The canary preview's P95 probe duration over the last hour is above 300 ms, for 30 minutes.

**Impact.** Slow previews for prospects (and worse Lighthouse scores in the quality gates); not an outage.

**First checks.**
- *Renderer and public surfaces* → *Probe duration* and *Edge latency p95 (Caddy)*: slow at the edge or slow in `sites`?
- *Host and containers* → *CPU*, *Load*, *Container CPU* for `sites`, `postgres` and the sandboxes.
- *Postgres and backups*: is the backup or a heavy query running (`BACKUP_AT`, the analytics refresh)?
- `docker compose -p bf logs --since 1h sites` for slow-query or cache-miss warnings.
- Did `@bf/site-blocks` or the renderer change in the last release?

**Fix.** Contention from generation → lower `GENERATION_MAX_SANDBOXES` or move it to VPS-2
([production.md §5](production.md#5-capacity)). A renderer regression → [rollback.md](rollback.md) and a fix.
Persistent slowness at low load → a performance ticket, not an incident.

### SendPipelineSlow

`warn`, owner `outreach`. More than 6% of due messages waited over 10 minutes between their slot and their first
attempt (`bf_outreach_queue_seconds`), over both the last 6 hours and the last 30 minutes; the SLO allows 1%.

**Impact.** Messages leave outside their planned windows (best-time scheduling and daily caps lose meaning); the
send-pipeline budget burns.

**First checks.**
- *Outreach* → *Due → attempt p95* and *Messages by status*.
- *Queues and the outbox* → *Oldest waiting job* for `outreach-tick` and `outreach-send` ([CriticalQueueBacklog](#criticalqueuebacklog) is the acute form).
- `docker compose -p bf logs --since 1h worker | grep -i "outreach"` for provider rate limits, mailbox sync errors, capacity refusals (`bf_outreach_capacity_refusals_total`).
- Are many mailboxes paused or warming (capacity shrinks while the due volume does not)?

**Fix.** Worker capacity or a stuck tick → restart the worker, then capacity ([production.md §5](production.md#5-capacity)).
Too much due volume for the mailboxes' daily caps → fewer enrollments or more mailboxes; the caps are deliberate
(deliverability) and must not be raised to hit the SLO.

### GenerationSlow

`ticket`, owner `generation`. More than 5% of generation jobs took over 30 minutes from creation to settling
(`bf_generation_job_seconds`), over both the last 3 days and the last 6 hours.

**Impact.** Users wait; the generation budget (5%) is spent; previews arrive after the outreach window they were
meant for.

**First checks.**
- *SLOs and error budgets* → *Generation over 30 min (3 d)*; *Generation and sandboxes* → *Job duration p50 / p95* and *Sandboxes*.
- Waiting for a slot (`bf_generation_queue_wait_seconds`, [SandboxesSaturated](#sandboxessaturated)) or running long (`bf_generation_phase_seconds` per phase: engine run, quality gates, repairs)?
- The repair loop: *Quality decisions* — many `repair` decisions double a job's length ([generation-quality.md](generation-quality.md)).
- Engine wall times vs `bf_sandbox_run_seconds` ([agent-runner-sizing.md](agent-runner-sizing.md#watch)).

**Fix.** Capacity → [production.md §5](production.md#5-capacity) (VPS-2 for generation first). Slow gates → the audit
timeouts and the critic's thresholds in [generation-quality.md](generation-quality.md). A slow engine or model →
engine configuration (BF-044), not infrastructure.

## outreach (`outreach.rules.yml`)

### OutreachSendFailureRate

`page`, owner `outreach`. Over 5% of send outcomes in 5 minutes are `failed` (`bf_outreach_messages_total{status="failed"}`),
with at least 5 messages, for 5 minutes: a provider is down, a mailbox lost its credentials, or a domain refuses our
mail.

**Impact.** Sequences stall and retries pile up; repeated failures to the same domains hurt reputation.

**First checks.**
- *Outreach* → *Messages by status* split by `provider`; *Mailbox syncs*.
- The dashboard's outbox, *Failed* tab: the last error per message (authentication, quota, 5xx from the provider, a recipient refusal).
- Outreach → Deliverability: mailbox status (`disconnected` means re-authentication is needed) and DNS checks.
- `docker compose -p bf logs --since 15m worker | grep -i "outreach-send"` (on the server; the lines carry recipient ids, not addresses).
- The provider's status page (Gmail / Microsoft 365 / SMTP relay).

**Fix.** Disconnected mailbox → the owner reconnects it from the dashboard (credentials live in the vault, never
in `.env`). Provider outage → the messages retry; pause the mailbox if the provider asks for it. A refusing domain →
suppress it and let the compliance owner know if it refused for policy reasons
([outreach-compliance.md §2](../compliance/outreach-compliance.md#2-mandatory-message-elements-all-jurisdictions)).
A release regression in the sender → [rollback.md](rollback.md).

### OutreachSendStuck

`page`, owner `outreach`. `bf_outreach_stuck_sending > 0` for 5 minutes: a message has been `sending` for more than
10 minutes past its lease. The minute tick should have re-leased it for reconciliation against the provider; the
worker or the tick is not running, or reconciliation keeps failing.

**Impact.** The message's fate is unknown (it may have gone out); nothing else to that recipient can proceed, and
the send-pipeline SLO burns. No duplicate is sent: a retry only happens after reconciliation by idempotency key.

**First checks.**
- *Queues and the outbox* → *Oldest waiting job* for `outreach-tick` and `outreach-send` ([CriticalQueueBacklog](#criticalqueuebacklog)).
- `docker compose -p bf ps worker`; `docker compose -p bf logs --since 30m worker | grep -i reconcil` and `bf_outreach_reconciliations_total{result}` in Prometheus.
- Valkey healthy ([ValkeyDown](#valkeydown))? A lost queue leaves leases with no tick to renew them.
- The mailbox provider's API reachable (reconciliation reads the sent folder)?

**Fix.** Worker or tick down → `docker compose -p bf restart worker`; the tick re-leases on the next minute.
Reconciliation failing on a disconnected mailbox → reconnect it; the message settles on the next tick. Never set a
message's status by hand in SQL: that bypasses the decision audit ([SendWithoutComplianceDecision](#sendwithoutcompliancedecision)).

### OutreachMailboxAutoPaused

`warn`, owner `outreach`. A deliverability rule paused a mailbox in the last 10 minutes
(`bf_outreach_mailbox_paused_total{reason}`): bounce rate, bounces during warming, or unsubscribe rate over the limit.
No `for`: it fires on the first pause.

**Impact.** That mailbox's due messages wait (the pipeline reassigns nothing automatically); the pause protected the
domain's reputation.

**First checks.**
- *Outreach* → *Automatic pauses* (by `reason`) and *Mailbox bounce rate (last 50 sends)*.
- Outreach → Deliverability in the dashboard: the mailbox, its health history and the rule that fired.
- What was sent in the last hour from it: one sequence, one list, one template? Unsubscribe spikes point at content or targeting; bounces at list quality.
- `docker compose -p bf logs --since 1h worker | grep -i "mailbox"` for the rule's evaluation (on the server).

**Fix.** Do not resume until the cause is fixed: verify the remaining addresses, fix the template or the targeting,
check the jurisdiction policy for the list ([outreach-compliance.md §1](../compliance/outreach-compliance.md#1-seeded-jurisdiction-policies-b2b-email)).
Then resume from the dashboard (the audit log records who and why). High unsubscribe rates are a legal signal, not
only a deliverability one: tell the compliance owner.

### OutreachKillSwitchActive

`warn`, owner `outreach`. `bf_outreach_kill_switch_active > 0`: a workspace stopped all sending (Outreach →
Deliverability, or `PUT /v1/deliverability/kill-switch`). It stays on until someone turns it off, so the alert
repeats every 4 hours as a reminder.

**Impact.** No message leaves that workspace, including sequence steps and replies drafted by the team. That is the
point — it is the first move in any compliance or deliverability incident.

**First checks.**
- The audit log (Settings → Audit, or `{service="api"} |= "kill_switch"`) says who turned it on and the reason.
- Is an incident open for it ([SendWithoutComplianceDecision](#sendwithoutcompliancedecision), [MailboxBounceRateHigh](#mailboxbounceratehigh), a provider complaint)?
- *Outreach* → *Kill switch* for when it went on; *Messages by status* for the backlog that will leave when it goes off.

**Fix.** Nothing to fix in the infrastructure. Turn it off only when the person who turned it on (or the compliance
owner) agrees the cause is resolved, then watch the first sends ([OutreachSendFailureRate](#outreachsendfailurerate)).
If nobody knows who turned it on, treat that as an incident: someone had access they should not have.

## generation-quality (`generation-quality.rules.yml`)

### GenerationQualityPlatformRegression

`page`, owner `generation`. Platform-tagged quality issues (renderer, fonts, scripts, layout landmarks —
`bf_generation_quality_platform_issues_total`) exceed 5 in an hour and three times the previous day's hourly rate,
for 15 minutes: a deploy broke the sites, not the engines. No repair loop runs on them; a person must look.

**Impact.** Every new version fails the accessibility or performance gate and waits in review; previews stop
shipping.

**First checks.**
- *Generation and sandboxes* → *Quality decisions* (`needs_review` rising) and the `gate` label of the platform issues (`a11y` or `performance`).
- A recent report's issues tagged `platform: true`: `GET /v1/generation-jobs/<id>/quality`.
- The last deploy's changes to `@bf/site-blocks`, `apps/sites` and the runner image (`cat /opt/bf/IMAGE_TAG`, the release notes).
- `docker compose -p bf logs --since 1h sites` for render errors (on the server).

**Fix.** [generation-quality.md → Platform regression](generation-quality.md#platform-regression): reproduce with
`sitekit audit`, then fix or [roll back](rollback.md) the platform change. The versions waiting in review are
accepted or retried once it is fixed.

### GenerationQualityGatesErroring

`warn`, owner `generation`. Over 10% of quality gate runs in 30 minutes ended `error`
(`bf_generation_quality_gates_total{status="error"}`): the gate could not run (sandbox missing or timed out, model API
failed), for 30 minutes. Such versions go to review, never through.

**Impact.** Reviews pile up; the repair loop cannot run; generation cost rises with retries.

**First checks.**
- The `gate` label: the sandbox gates (`a11y`, `performance`, auto-fixes) or the AI gates (`claims`, `critic`)?
- The worker's `/health/ready` (fails while the runner image is missing) and *Generation and sandboxes* → *Sandbox runs by outcome*.
- Model keys and the provider's status for the AI gates; the workspace's AI budget (*AI spend*).
- `docker compose -p bf logs --since 30m worker | grep -i quality` (on the server).
- Large sites timing out → `GENERATION_QUALITY_AUDIT_WALL_TIME_SEC`.

**Fix.** [generation-quality.md → Gates erroring](generation-quality.md#gates-erroring). A missing runner image →
`docker pull <image>@sha256:…` then restart the worker ([agent-runner-sizing.md](agent-runner-sizing.md#the-image)).
Once fixed, the waiting versions can be re-run with `POST /v1/generation-jobs/<id>/repair`.

### GenerationNeedsReviewSpike

`warn`, owner `generation`. Over 30% of quality decisions in 6 hours are `needs_review`
(`bf_generation_quality_decisions_total{decision="needs_review"}`), with more than 20 decisions, for an hour.

**Impact.** A person must look at most versions: throughput drops to review capacity.

**First checks.**
- *Generation and sandboxes* → *Quality decisions* per `engine`: one engine regressed, or both?
- `bf_generation_quality_gate_score{gate}` in Prometheus: which gate's score dropped (facts, copy, a11y, performance, critic)?
- A sample of `GET /v1/generation-jobs/<id>/quality` reports for the common issues.
- Facts failures everywhere → the registry or the extraction upstream changed; critic failures in one category → calibration.

**Fix.** [generation-quality.md → Needs review](generation-quality.md#needs-review): an engine regression (its
prompt or model version, BF-044), thresholds too strict for a category (`docs/quality/visual-rubric.md`), or a facts
problem upstream. Platform-caused issues are [GenerationQualityPlatformRegression](#generationqualityplatformregression).

## analytics (`analytics.rules.yml`)

### AnalyticsFactsDrift

`ticket`, owner `analytics`. The nightly reconciliation found a fact table differing from its source by more than 1%
(`bf_analytics_reconcile_max_drift_ratio`, over the last week: sent e-mails, leads, finished jobs) for 10 minutes: an
event was lost or a fact source misses rows.

**Impact.** Dashboards and reports are wrong by that margin; billing and cost ledgers that read the facts too.

**First checks.**
- Loki: `{service="worker"} |= "analytics facts drift from their source"` — the lines name the workspace and the metric.
- Was there an outbox backlog or a Valkey loss in the week ([OutboxBacklog](#outboxbacklog), [ValkeyDown](#valkeydown))? Lost events show up here.
- A point-in-time restore in the window ([restore.md §4](restore.md#4-restoring-production))?
- Is the drift growing night after night (a subscriber bug) or a one-off?

**Fix.** `pnpm analytics:backfill --since <date> --org <id>` (from a host with the production database and
`app.env`, as the deploy user), then confirm the next reconciliation reads under 1%. A growing drift is a bug in a
fact subscriber: ticket it with the metric and the week.

### AnalyticsIngestLagging

`ticket`, owner `analytics`. The P95 lag between an event and its analytics fact
(`bf_analytics_ingest_lag_seconds`) is over 2 minutes for 15 minutes: the outbox relay or the analytics subscribers
fall behind.

**Impact.** Live dashboards lag; the daily rollup may run on an incomplete day.

**First checks.**
- *Queues and the outbox* → *Outbox* and *Oldest waiting job* for `events` ([OutboxBacklog](#outboxbacklog), [CriticalQueueBacklog](#criticalqueuebacklog)).
- `docker compose -p bf logs --since 30m worker | grep -i analytics` for subscriber errors or slow inserts.
- *Postgres and backups* → *Transactions* and *Connections*: lock contention on the fact tables (the 15-minute refresh running at the same time?).
- A backfill in progress? It competes with live ingestion; let it finish.

**Fix.** Usually resolves with the queue or outbox fix; a persistent lag at normal load is a slow subscriber
(missing index, a per-event query) — ticket it with the `traceId` of a slow event.

### AnalyticsRefreshStale

`ticket`, owner `analytics`. The 15-minute analytics refresh (cost ledgers, daily rollup, partition creation) has not
succeeded for an hour (`bf_analytics_refresh_last_success_timestamp_seconds`), for 15 minutes.

**Impact.** Spend and daily trends are stale (including the numbers [AiSpendNearBudget](#aispendnearbudget) reads);
if it stays broken past month end, the next month's partitions are missing and inserts fail.

**First checks.**
- Loki: `{service="worker"} |= "analytics refresh failed"` — the error says which step.
- `docker compose -p bf ps worker`; is the scheduled job registered (it re-registers on worker start)?
- *Postgres and backups*: a lock held by a long transaction, or the database down earlier ([PostgresDown](#postgresdown))?
- Disk ([DiskFillingUp](#diskfillingup)) if partition creation fails.

**Fix.** Restart the worker if the schedule was lost (after a Valkey loss, [restore.md §5](restore.md#5-valkey-lost));
a failing step is a bug to ticket. Before month end, make sure the partitions exist — run the refresh by hand through
the worker (restart triggers it) and check the log says it succeeded.

---

## Adding an alert

1. Put the rule in the right file under `infra/observability/alerts/` (or a new `<area>.rules.yml`; Prometheus loads
   `*.rules.yml`). Every alert needs the labels `severity` (`page`, `warn` or `ticket`) and `owner` (`ops`,
   `outreach`, `generation`, `compliance` or `analytics`), a `summary` annotation, and
   `runbook_url: https://github.com/khanakhun/business-finder/blob/main/docs/runbooks/alerts.md#<alertname in lower case>`.
2. Use only metrics that exist (the names are in the exporters and in `apps/api/src/modules/**/metrics.ts`); give
   ratio alerts a minimum volume (`and sum(increase(…)) >= N`) so an empty night does not page.
3. Add a section here under the rule group, headed `### <AlertName>` exactly (GitHub lowercases it for the anchor):
   what it means, impact, first checks, fix, and the legal angle for anything that touches prospects.
4. Check the file before committing:
   ```
   docker run --rm --entrypoint promtool -v $PWD/infra/observability/alerts:/rules prom/prometheus:v3.13.4 check rules /rules/<file>
   ```
5. If the alert needs a dashboard panel, add it in `scripts/infra/gen-dashboards.mjs` and regenerate
   ([observability.md §1](observability.md#1-install-and-update)). On the server, copy the rules and reload Prometheus.
