# ADR-0014: Hosting on a US-East VPS with Docker Compose and Caddy

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-025, BF-061

## Context

Primary users are in Saint-Barthélemy (Caribbean); the operator is in Europe; prospects are mostly in the Caribbean/US. The system runs Postgres, Valkey, several app processes, a Python service, headless browsers (crawling, screenshots) and Docker-sandboxed agents. The team is small and already operates Docker on VPSs and uses Vercel and S3-compatible object storage.

## Decision

- **Region**: US-East (e.g. New York / Virginia) — lowest latency to the Caribbean among major regions, acceptable from Europe.
- **Topology (v1)**: one VPS for staging, one (later two) for production, each running Docker Compose (`infra/compose/docker-compose.prod.yml`): `caddy`, `web`, `api`, `worker`, `sites`, `intel`, `postgres`, `valkey`, `gmaps-scraper` (if enabled), `reacher` (only if the host allows outbound port 25), `docker-socket-proxy` for agent sandboxes.
- **Object storage**: S3-compatible (e.g. DigitalOcean Spaces, Cloudflare R2, AWS S3) with versioning.
- **TLS & routing**: Caddy with automatic HTTPS; wildcard certificate for `*.<sites-domain>` via DNS-01 challenge; custom client domains later via Caddy on-demand TLS gated by an `ask` endpoint that only approves domains attached to live sites.
- **Images**: built in CI, pushed to GHCR, deployed by tag; database migrations run as a one-shot `migrate` service before app containers update.
- **Option**: `apps/sites` may move to Vercel (wildcard domain + ISR) if global edge caching becomes important; the renderer only needs read access to published versions (via a read-only DB role or a public read API).
- **Backups**: nightly base backups + WAL archiving to object storage (pgBackRest or WAL-G), restore drill monthly (BF-061).

## Alternatives considered

| Option | Why not (now) |
|---|---|
| Kubernetes | Overkill for the scale and team; adds operational burden. |
| Fully managed PaaS (Render/Railway/Fly) | Convenient, but Docker-in-Docker sandboxes and headless browsers are awkward or costly; less control over egress. |
| Self-hosted PaaS (Coolify/Dokploy) | Viable alternative to raw Compose; may be adopted later without changing images. |
| EU region | Higher latency for Caribbean users. |

## Consequences

- Positive: simple, cheap, full control (egress rules, Docker sandboxes, port policies).
- Negative: single-host failure domain in v1; mitigated by backups, quick restore, and stateless app containers.
- Note: some providers block outbound SMTP port 25 by default; email **verification** (Reacher) needs it, while **sending** uses provider APIs (Gmail/Graph) and is unaffected.
