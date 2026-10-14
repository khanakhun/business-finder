# ADR-0005: NestJS modular monolith with hexagonal modules, HTTP and worker processes

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-006

## Context

The backend spans ~15 bounded contexts with rich domain logic (entity resolution, scoring, generation orchestration, compliance, outreach state machines), long-running background jobs, SSE streams and a public API for the site renderer. It must be robust, testable and easy for coding agents to extend consistently. The team is two people; microservices would multiply operational cost without benefit.

## Decision

- **NestJS** (`apps/api`) as a **modular monolith**: one codebase, one deployable image, two process types:
  - `main.ts` — HTTP (REST `/v1`, SSE, Better Auth handler, OpenAPI docs);
  - `worker.ts` — standalone Nest application context running BullMQ processors, repeatable jobs, the outbox relay and agent orchestration.
  Each process loads only the modules it needs (`AppModule.forHttp()` / `AppModule.forWorker()`).
- Each bounded context is a Nest module with **hexagonal layering** (`domain` / `application` / `infrastructure` / `interface`). Domain code is framework-free and unit-tested in isolation; adapters are integration-tested.
- **CQRS-lite**: commands (state changes, transactional, emit events) and queries (read-optimized, may use SQL views) are separate use-case classes. No event sourcing.
- Inter-module calls go through each module's exported application interfaces (`index.ts`); cross-module side effects go through domain events.
- Validation with Zod (shared contracts) instead of class-validator; OpenAPI generated from Zod schemas.
- Fastify adapter is optional later; start with Express adapter for compatibility with Better Auth's Node handler integration.

## Alternatives considered

| Option | Why not |
|---|---|
| Next.js route handlers / server actions as the whole backend | Good for small apps; weak for workers, DI, module boundaries and long-running jobs. The dashboard stays a pure client of the API. |
| Hono / Fastify minimal backend | Fast and light, but we'd rebuild DI, module system, guards, interceptors, testing utilities and BullMQ integration that NestJS provides. |
| Microservices | Operational overhead, distributed transactions, slower iteration for a 2-person team. |

## Consequences

- Positive: consistent structure agents can replicate; strong testing story (`@nestjs/testing`); BullMQ, health checks, throttling, OpenAPI ecosystem.
- Positive: worker scaling independent of HTTP (same image, different command).
- Negative: NestJS decorators/DI add some ceremony; mitigated by a module generator template and the reference module from BF-006.
- Negative: module boundaries are by convention + lint, not network — enforced by `scripts/check-boundaries.mjs`.

## References

- NestJS: https://docs.nestjs.com/
- Hexagonal architecture: Alistair Cockburn, "Ports and Adapters"
