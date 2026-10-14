# Architecture Decision Records

An ADR captures one significant decision: the context, the choice, the alternatives and the consequences. ADRs are immutable once accepted; to change a decision, write a new ADR that supersedes the old one and update the old one's status.

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo-pnpm-turborepo-uv.md) | Monorepo with pnpm workspaces, Turborepo and uv | Accepted |
| [0002](0002-typescript-first-with-python-sidecar.md) | TypeScript-first services with a Python sidecar for intel and ML | Accepted |
| [0003](0003-postgresql-as-primary-datastore.md) | PostgreSQL (PostGIS, pgvector, FTS, JSONB) as the single primary datastore | Accepted |
| [0004](0004-drizzle-orm-and-migration-ownership.md) | Drizzle ORM; `apps/api` owns writes and migrations | Accepted |
| [0005](0005-nestjs-modular-monolith.md) | NestJS modular monolith with hexagonal modules, HTTP and worker processes | Accepted |
| [0006](0006-bullmq-and-db-backed-state-machines.md) | BullMQ + DB-backed state machines for async work (Temporal deferred) | Accepted |
| [0007](0007-better-auth-with-organizations.md) | Better Auth with organizations for identity and multi-tenancy | Accepted |
| [0008](0008-global-business-graph-and-org-scoped-crm.md) | Global business graph with an org-scoped CRM layer | Accepted |
| [0009](0009-schema-driven-website-builder.md) | Schema-driven website builder (SiteSpec + block library + Puck) | Accepted |
| [0010](0010-pluggable-agent-engines-in-sandboxes.md) | Pluggable generation engines; coding agents in sandboxes | Accepted |
| [0011](0011-llm-gateway-ai-sdk-and-prompt-registry.md) | LLM gateway on the Vercel AI SDK with a prompt registry, evals and cost ledger | Accepted |
| [0012](0012-compliance-by-design-outreach.md) | Compliance-by-design outreach with a mandatory policy gate | Accepted |
| [0013](0013-discovery-providers-and-data-licensing.md) | Discovery providers, data licensing and retention | Accepted |
| [0014](0014-hosting-vps-compose-caddy.md) | Hosting on a US-East VPS with Docker Compose and Caddy | Accepted |
| [0015](0015-observability-otel-langfuse.md) | Observability with OpenTelemetry, pino/structlog, Langfuse and Sentry | Accepted |

## Template

```markdown
# ADR-NNNN: <decision in one line>

- Status: Proposed | Accepted | Superseded by ADR-XXXX
- Date: YYYY-MM-DD
- Tickets: BF-…

## Context
## Decision
## Alternatives considered
## Consequences
## References
```
