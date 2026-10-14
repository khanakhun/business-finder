---
id: BF-050
title: Mailboxes — Gmail/Workspace, Microsoft 365 and SMTP/IMAP adapters, caps, ramp-up, sending windows, rotation
milestone: M4 Reach
epic: outreach
type: feature
priority: P0
size: L
depends_on: [BF-010, BF-011, BF-012]
blocks: [BF-051, BF-052, BF-054, BF-056]
areas: [api, worker, web, security]
---

# BF-050 — Mailboxes: Gmail/Workspace, Microsoft 365 and SMTP/IMAP adapters, caps, ramp-up, sending windows, rotation

## Context
Outreach sends from the partners' **real mailboxes**, so replies land where they work and messages look personal ([ARCHITECTURE §12](../ARCHITECTURE.md#12-outreach-architecture)). Supported providers:
- Google Workspace / Gmail (API),
- Microsoft 365 (Graph),
- any SMTP + IMAP provider (fallback; Mailpit in development).

Sender reputation is fragile. Each mailbox therefore has a daily cap that ramps up gradually, sending windows in the recipient's timezone (Saint-Barthélemy is UTC−4), rotation across mailboxes with sticky threads, and automatic pausing on errors. The mailbox lifecycle follows [DOMAIN §3.7](../DOMAIN.md#37-mailbox). Credentials (OAuth refresh tokens, app passwords) live in the encrypted vault (BF-011).

This ticket provides the connection flows, the `MailboxProvider` port with send/sync primitives and the capacity/rotation policy. The outbound pipeline (BF-052) and inbound sync (BF-054) build on it.

## Goal
Members connect mailboxes via OAuth (Google, Microsoft) or SMTP/IMAP credentials. Owners and admins configure caps, ramp-up, windows, languages and signatures. The system exposes a provider-agnostic port for sending raw MIME and syncing changes, a `MailboxSelector` that picks the right mailbox for a send, usage accounting and health checks, all with a typed lifecycle and notifications.

## Scope
**In scope**
- **Tables**:
  - `mailboxes`:
    - `id`, `organization_id`, `owner_user_id`, `provider` (`gmail|graph|smtp_imap`), `email` (citext, unique per org), `display_name`, `status` (`connected|warming|active|paused|error`), `status_reason`;
    - `daily_cap`, `ramp` jsonb (`startCap`, `increment`, `everyDays`, `maxCap`, `startedAt`);
    - `window` jsonb (`days[]`, `start`, `end`, `timezoneMode`: `recipient|mailbox`, `mailboxTimezone`, `holidayCalendars[]`);
    - `min_interval_sec` (default 90), `locales` text[], `signature_md`, `reply_to?`;
    - `secret_ref` (vault), `provider_state` jsonb (Gmail `historyId`, Graph delta link, IMAP UIDVALIDITY/UID, push subscription ids + expiry);
    - `health` jsonb (last check, token ok, send test ok, dns summary filled by BF-056), `last_error` jsonb;
    - timestamps.
  - `mailbox_daily_usage`: `mailbox_id`, `day` (mailbox timezone), `sent`, `failed`, `bounced`, `complaints`, `replies`; PK (`mailbox_id`, `day`).
  - `mailbox_events` (audit-like): state transitions, cap changes, errors.
- **Lifecycle** (DOMAIN §3.7) as a typed state machine:
  - `connected → warming` when a ramp schedule is set (default: on);
  - `warming → active` when the ramp completes;
  - `active|warming → paused` (manual or automatic: BF-056 thresholds, provider quota errors);
  - `* → error` on authentication failure or revoked consent;
  - `error → connected` after reconnection.

  Each transition emits an event (`mailbox.paused`, …) and an owner notification.
- **`MailboxProvider` port** (`@bf/contracts/mailbox` + `apps/api/src/modules/outreach/infrastructure/mailboxes/`):
  ```ts
  interface MailboxProvider {
    readonly kind: 'gmail' | 'graph' | 'smtp_imap';
    readonly capabilities: { push: boolean; threads: boolean; rawMime: boolean };
    sendRaw(mbx: MailboxCtx, mime: Buffer, opts: { threadHint?: string; signal: AbortSignal }):
      Promise<{ providerMessageId: string; rfc822MessageId: string; providerThreadId?: string }>;
    syncChanges(mbx: MailboxCtx, cursor: SyncCursor | null): Promise<{ messages: RawInbound[]; next: SyncCursor }>;
    ensurePush?(mbx: MailboxCtx): Promise<PushSubscription>;   // watch/subscriptions; renew before expiry
    checkHealth(mbx: MailboxCtx): Promise<HealthReport>;
  }
  ```
  `syncChanges` and push are implemented here at the transport level (fetch, parse to `RawInbound` with headers and body parts). Threading, triage and storage of inbound messages are BF-054.
- **Gmail adapter** (googleapis):
  - OAuth 2.0 (offline access) with the minimal scopes for send + read/sync (verify the current scope names and their *restricted* status).
  - Document the deployment model. The recommended path is an OAuth client configured as **Internal** to the agency's Google Workspace, which avoids external app verification for restricted scopes. Alternative: a service account with domain-wide delegation configured by the Workspace admin. Check current Google policies and record the decision in the PR.
  - `users.messages.send` with raw MIME (base64url), keeping the threadId for follow-ups.
  - The Gmail API may replace a client-supplied `Message-ID`. After sending, read back the stored message's actual `Message-ID` header (`users.messages.get` with `format=metadata`) and return that as `rfc822MessageId`. Apply the same read-back rule to any provider whose behaviour is uncertain (verify Graph's `internetMessageId` handling too).
  - `users.watch` + Pub/Sub push is optional (needs a public endpoint and a Pub/Sub topic; feature-flagged); history-based polling via `users.history.list` is the default fallback.
  - Map quota and rate-limit errors (429/403 `rateLimitExceeded`/`dailyLimitExceeded`) to typed errors.
- **Microsoft Graph adapter** (`@microsoft/microsoft-graph-client` + MSAL Node):
  - Delegated permissions for send and read (verify the current minimal permission set) + `offline_access`.
  - Send raw MIME via `sendMail` with MIME content, or the draft + send flow to obtain `internetMessageId`. Verify which path returns the identifiers needed for threading, and use it.
  - Delta queries for sync; change-notification subscriptions are optional (public endpoint, renewal before expiry).
  - Throttling (`429` + `Retry-After`) respected.
- **SMTP/IMAP adapter** (nodemailer + ImapFlow):
  - TLS required (STARTTLS or implicit); app passwords in the vault.
  - `sendRaw` via SMTP (envelope from the MIME), then append to the "Sent" folder over IMAP when the provider doesn't do it automatically (configurable).
  - Sync via UID-based fetch since the last UID (IDLE optional).
  - Connection pooling with per-mailbox concurrency 1.
  - **Development**: the Mailpit SMTP + API combination is used in local and E2E environments (BF-002), so the whole pipeline is testable without real mailboxes.
- **Connection flows** (permission `settings:manage` for shared mailboxes; members can connect their own mailbox):
  - OAuth: `GET /v1/mailboxes/oauth/:provider/start` → provider consent (`state` with PKCE + org + user, signed, 10-minute TTL) → `GET /v1/mailboxes/oauth/:provider/callback` → token exchange → vault storage → mailbox `connected` → health check.
  - SMTP/IMAP: `POST /v1/mailboxes` with host/port/security/username/password (validated by a live connection test before saving; secrets go only to the vault).
  - Reconnect and disconnect (revoke tokens where the provider supports it; purge the vault secret; keep history).
- **Token handling**:
  - Refresh with single-flight locking per mailbox (Valkey lock), proactively before expiry.
  - Refresh failure or revoked consent → `error` + notification.
  - Tokens never logged and never returned by the API.
- **Capacity and rotation policy** (pure domain):
  - `effectiveCap(mailbox, today)` = ramp formula (`min(maxCap, startCap + increment * floor(daysSinceStart / everyDays))`), bounded by `daily_cap`; `0` when paused or in error.
  - `nextSendSlot(mailbox, recipientTz, now)` applies the window (days, hours, holidays) in recipient or mailbox timezone, `min_interval_sec`, and jitter (±30%). Also checks the per-recipient-domain token bucket (e.g. ≤ 3/hour per domain per workspace) and the workspace global daily cap.
  - `MailboxSelector.select({ orgId, businessId, recipientLocale, recipientTz, threadStickiness })`:
    1. **sticky** mailbox for an existing thread or business (follow-ups from the same sender);
    2. otherwise filter mailboxes by status, language and remaining capacity;
    3. rank by remaining capacity ratio, recent bounce rate and round-robin fairness.

    Returns the mailbox + a scheduled send time, or `NO_CAPACITY` with the next available time.
  - Usage accounting API for BF-052: `reserve(mailbox, day)` / `commit` / `release` (atomic counters in Valkey, persisted to `mailbox_daily_usage`).
- **Health checks** (repeatable hourly per mailbox):
  - token validity, provider reachability, quota status;
  - optional weekly send test to a seed address (configurable; off by default);
  - an inline DNS summary placeholder filled by BF-056.
- **APIs**:
  - `GET /v1/mailboxes`, `GET /v1/mailboxes/:id` (status, effective cap today, usage, next window, health);
  - `PATCH /v1/mailboxes/:id` (caps, ramp, window, locales, signature, reply-to; validation: cap ≤ provider-safe maximum from config, e.g. Gmail/Workspace defaults);
  - `POST /v1/mailboxes/:id/pause|resume` (resume requires passing health);
  - `POST /v1/mailboxes/:id/test` (send a test to the user's own address);
  - `DELETE /v1/mailboxes/:id`.
- **UI** (Settings → Mailboxes):
  - Connect buttons (Google, Microsoft, SMTP/IMAP form with presets for common providers), status chips, today's cap/usage, a ramp chart (planned vs actual), a window editor with a timezone preview ("Sends to Saint-Barthélemy recipients between 8:30–17:30 AST"), a signature editor (markdown → sanitized HTML preview), pause/resume, test send, reconnect.
  - Errors are explained with fix steps (e.g. "Google consent revoked: reconnect").

**Out of scope**
- MIME composition with compliance headers and the send pipeline (→ BF-052), inbound threading/triage/inbox (→ BF-054), DNS authentication checks and auto-pause thresholds (→ BF-056), third-party "warm-up networks" (not supported by design).

## Requirements
### Functional
- A mailbox never exceeds its effective cap; sends outside the window are scheduled into the next window slot; follow-ups reuse the original mailbox (stickiness), unless it is paused or in error, in which case the thread waits or the user is asked to reassign.
- OAuth flows are CSRF-safe (signed state + PKCE) and tokens are stored only in the vault.
### Non-functional
- `MailboxSelector.select` P95 < 15 ms; capacity counters are atomic under concurrent workers (tested).
- Every provider call uses timeouts, retries with jitter and circuit breakers (cockatiel); provider throttling is respected.

## Design
```
packages/contracts/src/mailbox/{mailbox.ts, provider.ts, capacity.ts, api.ts}
apps/api/src/modules/outreach/
├── domain/mailbox/{mailbox.ts, mailbox-state-machine.ts, capacity-policy.ts, window-policy.ts, selector.ts}
├── application/mailbox/{connect-oauth.ts, connect-smtp.ts, update-mailbox.ts, pause-resume.ts, health-check.ts,
│                         usage.ts}
├── infrastructure/mailboxes/{providers/{gmail.provider.ts, graph.provider.ts, smtp-imap.provider.ts},
│                             oauth/{google.oauth.ts, microsoft.oauth.ts, state-signer.ts},
│                             token-refresher.ts (single-flight), usage-counters.ts (Valkey + flush),
│                             processors/{health.processor.ts, push-renewal.processor.ts}}
└── interface/http/{mailboxes.controller.ts, oauth.controller.ts}
apps/web/src/features/mailboxes/{mailboxes-page.tsx, connect-dialogs/*, window-editor.tsx, ramp-chart.tsx,
                                 signature-editor.tsx}
```
- Patterns:
  - Adapter (providers).
  - State Machine (lifecycle).
  - Strategy (rotation ranking).
  - Token Bucket (domain throttling).
  - Single-flight (token refresh).
  - Reservation pattern (capacity reserve/commit/release).
- Holidays: a small dataset for FR (incl. BL-specific holidays where known) and US, as data; configurable per mailbox.

## Implementation plan
1. Verify the current Gmail API scopes and verification policy, the Graph permissions/send flows, and nodemailer/ImapFlow APIs; record the decisions.
2. Contracts, tables, lifecycle state machine, capacity/window/selector domain (TDD with fake clock and timezones).
3. SMTP/IMAP adapter + Mailpit dev path (enables the end-to-end pipeline early).
4. Gmail adapter (OAuth, send raw, history sync, optional watch).
5. Graph adapter (OAuth via MSAL, send with ids, delta sync, optional subscriptions).
6. Token refresher, usage counters, health processor, notifications.
7. APIs + Settings UI; E2E with Mailpit.

## Testing
- **Unit:**
  - ramp formula;
  - windows across DST changes and timezones (UTC−4 AST has no DST; FR has DST);
  - holidays;
  - selector ranking and stickiness;
  - domain token bucket;
  - state transitions;
  - OAuth state signing and expiry.
- **Integration:**
  - SMTP adapter against Mailpit (send raw, message appears with the exact headers);
  - IMAP sync via a GreenMail or Dovecot test container (UID cursor);
  - Gmail and Graph adapters with MSW-recorded fixtures (send, throttling, token refresh failure → `error` state);
  - concurrent reservations never exceed the cap (100 parallel reservations).
- **E2E:** connect an SMTP mailbox (Mailpit) → set the window → test send arrives; pause/resume; settings validation errors.

## Acceptance criteria
- [ ] Gmail/Workspace, Microsoft 365 and SMTP/IMAP connections with secure OAuth/credential handling and the vault.
- [ ] `MailboxProvider` port with raw MIME send (returning provider and RFC 822 ids) and transport-level change sync.
- [ ] Lifecycle state machine with notifications; health checks; token refresh with single-flight.
- [ ] Capacity (ramp), windows (recipient timezone, holidays), interval/jitter, domain throttling, global cap, rotation with stickiness; atomic usage accounting.
- [ ] Settings → Mailboxes UI; Mailpit-based end-to-end path for development and CI.

## Agent prompt
```text
Implement BF-050 (Mailboxes).

Read first: AGENTS.md, docs/ARCHITECTURE.md §12, docs/DOMAIN.md §3.7 (mailbox lifecycle), docs/conventions/
security.md (§2 secrets, §7 logging), BF-011 (vault, settings), BF-012 (events/notifications), BF-010 (permissions).
Skim BF-052 (will call MailboxSelector and sendRaw), BF-054 (will use syncChanges/push) and BF-056 (auto-pause, DNS).

Rules:
- Verify current provider docs (Gmail API scopes + verification policy, Graph permissions/send semantics, nodemailer,
  ImapFlow) before coding; document the deployment decision for Google (Internal app vs domain-wide delegation).
- Secrets only in the vault; tokens never logged/returned; OAuth with signed state + PKCE.
- Capacity is enforced atomically; windows computed in the recipient timezone; follow-ups sticky to the mailbox.
- No warm-up networks or deceptive practices; ramp-up is gradual real sending only.
- Mailpit path must make the whole pipeline testable without real mailboxes.

Verify: pnpm verify && pnpm test:int && pnpm e2e (mailboxes with Mailpit).
```

## References
- docs/ARCHITECTURE.md §12 · docs/DOMAIN.md §3.7 · BF-011
- Gmail API sending: https://developers.google.com/workspace/gmail/api/guides/sending · Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes · Gmail push notifications: https://developers.google.com/workspace/gmail/api/guides/push
- Microsoft Graph send mail: https://learn.microsoft.com/en-us/graph/api/user-sendmail · Graph delta query for messages: https://learn.microsoft.com/en-us/graph/delta-query-messages
- nodemailer: https://nodemailer.com/ · ImapFlow: https://imapflow.com/ · Mailpit: https://mailpit.axllent.org/
