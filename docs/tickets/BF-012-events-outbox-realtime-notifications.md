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
- [x] Events recorded transactionally and delivered to all subscribers idempotently (tests with concurrent relays).
- [x] `/v1/realtime` SSE with heartbeat, org isolation and `Last-Event-ID` replay.
- [x] Web realtime provider invalidates queries from a central map.
- [x] Notifications (in-app + optional email) with preferences; bell UI with live count.
- [x] Identity events flow to the audit log through subscribers.
- [x] Metrics: outbox lag, dispatch counts, SSE connections.

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

## Implementation notes
- **Split**: part 1/3 outbox (afterCommit hook, `outbox_events`, recorder, registry/decorator, relay, processor,
  reconciler, replay endpoint, identity events → audit subscriber); part 2/3 realtime (publisher, multiplexer,
  `serveSse`, `/v1/realtime`, web provider); part 3/3 notifications (tables, service, API, email, bell, pages).
- **Recorder**: inserts into `outbox_events` through `getExecutor()` and runs `SELECT pg_notify('bf_outbox', '')` in
  the same transaction. DECISION: NOTIFY is transactional in Postgres (delivered on commit, dropped on rollback), so
  it does not need the `afterCommit` hook; the hook exists in `@bf/db` (`afterCommit(db, fn)`, savepoint-aware) for
  side effects that are not transactional. Correlation id = request id (or the handled event's), causation id = the
  handled event; actor = user / API key / handling subscriber / system. Request IP, user agent and `traceparent` are
  kept in a `context` column (delivery metadata, not part of the envelope) so the audit subscriber keeps them and
  delivery continues the trace.
- **Relay** (worker): LISTEN + 2 s polling; batches of 100 claimed with `FOR UPDATE SKIP LOCKED`; one `events` job
  per event × subscriber with job id/idempotency key `<eventId>:<subscriberId>`; marked dispatched in the same
  transaction; failed dispatch → `attempts`, `last_error`, exponential `available_at` (≤ 5 min). Queue name
  `events` (BullMQ/`defineJob` names are kebab-case, so not `system.events`). Reconciler (every minute) makes events
  undispatched for 5 min due again and publishes `bf_outbox_pending_events`.
- **Subscribers**: `@OnDomainEvent([Definition], { id })`, discovered at boot in every process (so the API can
  validate replays). Identity events (now incl. `identity.member_joined` from Better Auth's
  `afterAcceptInvitation`) reach the audit log through `workspace.audit-identity`; the audit row takes the event id
  (`ON CONFLICT DO NOTHING`), so redelivery writes nothing.
- **Replay**: `POST /v1/events/{eventId}/replay` — `settings:manage` route, owner role required in the use case,
  event must belong to the caller's workspace (else 404), fresh idempotency key, audited (`events.replayed`).
- **Realtime**: `rt:org:<orgId>` Valkey stream (`MAXLEN ~ 1000`) + channel; SSE `id` = stream entry id, so
  `Last-Event-ID` (header, or `?lastEventId=` for a fresh EventSource) maps to an exclusive `XRANGE`; a client older
  than the retained window gets `resync`. One `PSUBSCRIBE rt:org:*` per API process. `serveSse` subscribes before
  replaying (buffer + dedupe, no gap), writes `: ready`, heartbeats every 15 s, sends `resync` and disconnects a
  client with > 1 MiB buffered (also checked on heartbeats), and closes streams after 5 min so a revoked session or
  removed member stops receiving events quickly (the reconnect replays what was missed). A failing replay cleans up
  exactly once. After the Valkey subscription reconnects, open streams get `resync`. Max 5 streams per user/API key
  and 2000 in total per process (429).
- **Web**: `RealtimeProvider` (one EventSource per tab, backoff reconnect when the browser gives up),
  `useRealtimeEvent`, `realtimeInvalidations` (event type → query keys); event names mirrored as strings so the
  shell does not import the contracts barrel (bundle budget).
- **Notifications**: rows fanned out per recipient at creation (read state per user; `user_id` stays nullable as the
  ticket specified); `source_event_id` unique per user (idempotent); preferences per user/workspace/type with
  registry defaults in `@bf/contracts`; email (best effort, localized copy, absolute link from `APP_URL`) through
  identity's system mailer, sent only the first time an event reaches a user (in-app row, or a Valkey marker when
  in-app is off), so redelivery or replay never emails twice. Links must be dashboard paths (contract regex, checked
  again in the service and the UI). The `notification.created` nudge is anonymous (no recipient or notification id
  on the shared workspace stream) and sent once per notify call.
  `POST /v1/notifications/test` (404 in production) records `system.test_notification_requested` → subscriber →
  notification → SSE → bell (used by E2E).
- **Reviews**: security and code reviews — no critical/high; fixed duplicate emails on redelivery, SSE cleanup and
  timer leak on failed replay, heartbeat backpressure, resync after Valkey reconnect, recipient ids on the shared
  stream, link validation, global stream cap, duplicate LISTEN. The dev test endpoint relies on `NODE_ENV`, which
  only allows development/test/production (staging runs as production).
- **Tests**: API 207 unit / 88 integration (rollback/commit, two relays racing with duplicate wake-ups, retrying
  subscriber isolated from others, reconciler, correlation/causation, identity → audit with request facts, replay
  authz, SSE receive/replay/resync/isolation/limits, notifications flow, preferences, member-joined email), `@bf/db`
  31 integration (afterCommit), web 63 unit, E2E 36 (bell count rises without reload) green three runs in a row.

