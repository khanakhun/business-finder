---
id: BF-012
title: Domain events, transactional outbox, realtime (SSE) and notifications
milestone: M1 Find & List
epic: foundations
type: feature
priority: P0
size: L
depends_on: [BF-006, BF-010]
blocks: [BF-016, BF-020, BF-024, BF-027, BF-035, BF-039, BF-048, BF-049, BF-050, BF-055, BF-058]
areas: [api, worker, web]
---

# BF-012 — Domain events, transactional outbox, realtime (SSE) and notifications

## Context
Modules communicate asynchronously through domain events delivered reliably via a transactional outbox ([ARCHITECTURE.md §7.2](../ARCHITECTURE.md#72-patterns), [ADR-0006](../adr/0006-bullmq-and-db-backed-state-machines.md)). The UI needs live progress (discovery runs, generation jobs, replies) over SSE ([api.md §7](../conventions/api.md#7-server-sent-events)). Users need in-app notifications for important events. Event envelope and realtime base schemas exist in `@bf/contracts` (BF-004).

## Goal
Use cases record domain events inside their DB transaction; a relay delivers each event to every subscriber exactly-once-effectively via BullMQ; workers publish realtime events to org-scoped SSE streams with resume support; the web app reacts by invalidating queries; notifications are created from events and shown in the top-bar bell (with optional email).

## Scope
**In scope**
- Table `outbox_events`: `id` (event id), `type`, `version`, `organization_id`, `payload` jsonb, `actor` jsonb, `correlation_id`, `causation_id`, `occurred_at`, `dispatched_at`, `attempts`, `last_error`; partial index on `dispatched_at IS NULL`.
- `platform/events`:
  - `EventRecorder` (request/transaction-scoped): `record(event)` validates against the event registry (`defineEvent` from contracts) and inserts into `outbox_events` via `getExecutor()`; after commit issues `pg_notify('bf_outbox', '')` (use a transaction `afterCommit` hook pattern from `@bf/db` — add one if missing).
  - Subscribers: `@OnDomainEvent('business.created', { id: 'enrichment.start-on-create' })` decorator on application handlers; registry built at worker boot.
  - Relay (worker): `LISTEN bf_outbox` + 2 s polling fallback; claims batches with `FOR UPDATE SKIP LOCKED`; for each event × matching subscriber enqueues a BullMQ job on `system.events` with idempotency key `eventId:subscriberId` and the event's trace context; marks event dispatched; retries/backoff for relay failures; metrics (lag, throughput).
  - Event processor: runs the subscriber handler with log/trace context, correlation/causation ids propagated so events emitted by handlers link back.
  - Reconciler: re-dispatch events stuck undispatched > N minutes; admin endpoint to replay an event to a subscriber (owner only).
- Realtime:
  - `RealtimePublisher.publish(orgId, event: RealtimeEvent)` → `XADD rt:org:<orgId> MAXLEN ~ 1000` + `PUBLISH rt:org:<orgId>`.
  - `GET /v1/realtime` SSE (auth, org from context): on connect replays from `Last-Event-ID` via `XRANGE`, then streams live messages from a per-process subscriber multiplexer; heartbeat every 15 s; backpressure handling (drop to "resync" event if client too slow); connection limits per user.
  - Generic resource streams helper for later tickets (e.g. generation job events) with persisted-log replay.
  - Web: `RealtimeProvider` (EventSource with exponential backoff reconnect, `Last-Event-ID` handled by the browser), `useRealtimeEvent(type, handler)`, and a central `realtimeInvalidations` map (event type → query keys) wired into TanStack Query.
- Notifications:
  - Tables `notifications` (`id`, `organization_id`, `user_id` nullable = all members, `type`, `title_key`, `body_key`, `params` jsonb, `entity_type`, `entity_id`, `link`, `read_at`, `created_at`) and `notification_preferences` (`user_id`, `organization_id`, `type`, `in_app` bool, `email` bool).
  - `NotificationService.notify(...)` used by subscribers; email delivery via `SystemMailer` (BF-010) respecting preferences; per-type defaults defined in a registry (`reply_received`, `lead_captured`, `batch_completed`, `discovery_completed`, `mailbox_paused`, `member_joined`).
  - APIs: list (cursor, unread filter), mark read/all read, preferences get/update.
  - Web: bell with unread count (realtime), dropdown list, notifications page, preferences in `/settings/notifications`.
- Wire BF-010's identity events (`member_invited`, etc.) through the outbox and into the audit log (BF-011) via subscribers.

**Out of scope**
- Feature-specific events and handlers (each feature ticket defines its events and subscribers). Push notifications/mobile.

## Requirements
### Functional
- If the business transaction rolls back, no event is dispatched; if it commits, every subscriber eventually processes the event once (idempotent).
- SSE clients reconnecting with `Last-Event-ID` receive missed events within the retention window (≤ 1000 per org).
### Non-functional
- Outbox dispatch lag p95 < 500 ms under normal load; relay survives Postgres/Valkey restarts.
- SSE: one Valkey subscription per API process (not per client).

## Design
```
apps/api/src/modules/platform/events/{event-recorder.ts, on-domain-event.decorator.ts, subscriber-registry.ts,
  outbox.repository.ts, outbox-relay.service.ts, event.processor.ts, reconciler.ts}
apps/api/src/modules/realtime/{realtime.publisher.ts, sse.controller.ts, multiplexer.ts, notifications/*}
apps/web/src/lib/realtime/{provider.tsx, use-realtime-event.ts, invalidations.ts}
```
- Patterns: Transactional Outbox, Observer (subscribers), Competing Consumers (BullMQ), Idempotent Receiver.

## Implementation plan
1. `afterCommit` hook in `@bf/db` transaction context (if absent) with tests.
2. Outbox table, recorder, registry, decorator.
3. Relay + processor + reconciler with integration tests (multiple worker instances racing).
4. Realtime publisher + SSE endpoint + multiplexer; web provider + hooks.
5. Notifications domain, APIs, email delivery, web bell/page/preferences.
6. Identity events wiring + audit subscriber.

## Testing
- Integration: rollback → no outbox row; commit → subscriber runs once even with two relays and duplicate notifications; subscriber failure retries without affecting other subscribers; reconciler re-dispatches stuck events; correlation/causation propagation.
- SSE: connect, receive event; disconnect, publish 3 events, reconnect with `Last-Event-ID` → receive the 3; heartbeat present; cross-org isolation (user of org A never receives org B events).
- Notifications: preference off → no email; mark-read flows; realtime unread count.
- E2E: trigger a test event (dev-only endpoint) → bell count increments without reload.

## Acceptance criteria
- [ ] Events recorded transactionally and delivered to all subscribers idempotently (tests with concurrent relays).
- [ ] `/v1/realtime` SSE with heartbeat, org isolation and `Last-Event-ID` replay.
- [ ] Web realtime provider invalidates queries from a central map.
- [ ] Notifications (in-app + optional email) with preferences; bell UI with live count.
- [ ] Identity events flow to the audit log through subscribers.
- [ ] Metrics: outbox lag, dispatch counts, SSE connections.

## Agent prompt
```text
Implement BF-012 (Domain events, transactional outbox, realtime SSE and notifications).

Read first: AGENTS.md, docs/ARCHITECTURE.md §5.3 and §7, docs/adr/0006, docs/DOMAIN.md §4, docs/conventions/api.md §7.
Reuse: @bf/db transaction context (BF-003), @bf/queue typed processors (BF-006), RequestContext/auth (BF-010),
audit logger (BF-011), @bf/contracts event/realtime schemas (BF-004).

Rules:
- Correctness first: write the concurrency/idempotency integration tests (two relays, duplicate NOTIFYs,
  crashed processor) before optimizing.
- One Valkey subscriber per API process, multiplexed to SSE clients; never one connection per browser tab.
- Events are past-tense facts with versioned payload schemas; never put secrets or full PII in payloads.

Verify: pnpm verify && pnpm test:int && pnpm e2e; include a short demo (curl -N /v1/realtime) in the PR.
```

## References
- docs/ARCHITECTURE.md §7 · ADR-0006 · docs/DOMAIN.md §4 · docs/conventions/api.md §7
- Transactional outbox: https://microservices.io/patterns/data/transactional-outbox.html · Redis Streams: https://valkey.io/topics/streams-intro/ · SSE spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
