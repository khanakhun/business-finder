---
id: BF-052
title: One-click send and outbound pipeline — compliance-gated outbox, MIME + RFC 8058 headers, exactly-once send, bulk approval
milestone: M4 Reach
epic: outreach
type: feature
priority: P0
size: L
depends_on: [BF-049, BF-050, BF-051, BF-055]
blocks: [BF-053, BF-054, BF-056, BF-057, BF-058, BF-060]
areas: [api, worker, web]
---

# BF-052 — One-click send and outbound pipeline: compliance-gated outbox, MIME + RFC 8058 headers, exactly-once send, bulk approval

## Context
The user wants this flow: "I see a business with a high score; I click one button; an email goes out." [PRD J4](../PRD.md#5-key-user-journeys) and FR-53 describe it. The click must be **fast for the user and safe by construction**:
- a persisted compliance decision exists before queuing;
- compliance is re-evaluated at send time;
- the mandatory footer and RFC 8058 one-click unsubscribe headers are always present;
- the mailbox selection respects caps, windows and stickiness;
- the provider send has exactly-once effect even across crashes.

The outbound message lifecycle is [DOMAIN §3.5](../DOMAIN.md#35-outbound-message). The building blocks exist:
- compliance gate and suppression (BF-049);
- mailboxes, selector and capacity (BF-050);
- drafts, renderer and the shared `FooterComposer` (BF-051);
- unsubscribe tokens and public endpoints (BF-055).

## Goal
An `outbound_messages` aggregate with the DOMAIN §3.5 state machine; a one-click send API with an undo window; bulk send with an approval queue; a DB-scheduled send worker with send-time re-evaluation, mailbox reservation, MIME composition and provider send with reconciliation; manual-contact logging; CRM and realtime side effects; and outbox/approvals UIs.

## Scope
**In scope**
- **Tables**:
  - `email_threads`: `id`, `organization_id`, `business_id`, `contact_id`, `mailbox_id`, `subject_root`, `provider_thread_id?`, `root_message_id` (RFC 822), `status` (`open|replied|closed`), `last_message_at`, timestamps (extended by BF-054 for inbound).
  - `outbound_messages`:
    - references: `id`, `organization_id`, `business_id`, `contact_id`, `thread_id`, `mailbox_id?`, `draft_id?`, `sequence_enrollment_id?`, `sequence_step?`;
    - content: `purpose`, `offer`, `locale`, `subject`, `body_text`, `body_html`, `headers` jsonb;
    - tokens: `unsubscribe_token_id`, `outreach_token` (signed short token appended to preview links as `?r=`);
    - compliance: `enqueue_decision_id` (**required to enter `queued`**), `send_decision_id?`, `lawful_basis_id`, `footer_version`;
    - lifecycle: `status`, `scheduled_at`, `sent_at?`, `provider_message_id?`, `rfc822_message_id`, `provider_thread_id?`, `attempts`, `last_error` jsonb;
    - control: `idempotency_key` (unique), `created_by`, `approved_by?`, `approved_at?`, timestamps.

    Indexes for the scheduler (`status`, `scheduled_at`) and the per-business history.
  - `manual_contact_logs`: `id`, `organization_id`, `business_id`, `contact_id?`, `channel` (`email|phone|whatsapp|letter|in_person`), `decision_id`, `summary`, `outcome?`, `created_by`, `created_at` (also used by BF-057).
- **Domain**:
  - `OutboundMessage` aggregate:
    - typed transition table from DOMAIN §3.5;
    - constructor requires a branded `ComplianceDecisionId` with `allowed|allowed_with_conditions` (compile-time + runtime guard);
    - `markSending`, `markSent`, `markFailed`, `markBlocked`, `cancel`;
    - terminal states immutable.
  - Error taxonomy: `retryable` (network, 5xx, throttled, mailbox temporarily without capacity → reschedule rather than fail) vs `permanent` (auth error → mailbox `error` and message waits for reassignment; permanent SMTP 5xx recipient errors → `failed` final + contact flagged).
- **Commands and API** (permission `outreach:send`; `Idempotency-Key` required):
  - `POST /v1/outreach/messages`: `{ draftId, subjectVariantIndex?, mailboxId?, scheduleAt?, sendMode: 'now'|'schedule' }`. In one transaction:
    1. load the draft and render it with `FooterComposer` (identical to the BF-051 preview; byte-equality test);
    2. `ComplianceService.evaluate(stage: 'enqueue')`;
    3. if allowed, create the message (`queued`, `scheduled_at = max(now + undoWindow, scheduleAt)`; undo window default 10 s, configurable) + thread + outbox event `outreach.message.queued`.

    Not allowed:
    - `manual_only` → `409` with reasons + alternatives (UI offers "Copy & send manually" + a manual log);
    - `blocked` → `422` with reasons.
  - `POST /v1/outreach/messages/:id/cancel` (while `queued`/`pending_approval`; the undo toast calls it), `POST /v1/outreach/messages/:id/reschedule`, `POST /v1/outreach/messages/:id/retry` (`failed`, attempts left).
  - **Bulk**: `POST /v1/outreach/bulk` `{ businessIds[] (≤ 100), offer, purpose, templateId?, mode: 'ai'|'template', mailboxStrategy: 'auto' }`:
    - creates an `outreach_bulk_runs` record;
    - enqueues per-business draft generation (BF-051) + compliance preview;
    - results land in an **approval queue** as `pending_approval` messages (each with its own enqueue decision);
    - businesses blocked or manual-only are listed separately with reasons;
    - approvers review (edit inline, approve, reject, approve all with a final count confirmation);
    - approval re-evaluates compliance and moves the message to `queued`.
    - **Auto-approve** is possible only when `outreach:auto_send` is held, `org_settings.features.autoSend` is on, and `ComplianceService.isAutoSendPermitted(jurisdiction, 'email')` is true for each item. Default: off.
  - `POST /v1/outreach/manual-log` `{ businessId, contactId?, channel, summary, outcome? }`: evaluates compliance (stage `manual_log`), refuses on `blocked` (suppression/do-not-contact) and stores the log + decision; CRM side effects as for a send.
  - Queries: `GET /v1/outreach/messages` (filters: status, mailbox, business, date; cursor), `GET /v1/outreach/messages/:id` (rendered content, headers, decisions with explanations, timeline).
- **Scheduler and send worker**:
  - `outreach.tick` (every minute, DB-backed scheduler per ADR-0006):
    - claims due `queued` messages with `FOR UPDATE SKIP LOCKED` in small batches;
    - transitions them to `sending` with a lease (`lease_until`);
    - enqueues `outreach.send` (BullMQ job id = message id; per-mailbox limiter).
  - `outreach.send` processor:
    1. **Re-evaluate** compliance (`stage: 'send'`). A suppression or status change since enqueue → `blocked` with reasons, and capacity is released.
    2. **Mailbox**: sticky thread mailbox or `MailboxSelector.select()`. Reserve capacity; if there is no capacity or the window is closed, reschedule to the next slot (back to `queued` with a new `scheduled_at`; not an attempt).
    3. **Compose MIME** (nodemailer `MailComposer` or equivalent):
       - `From` (mailbox display name + address), `To` (contact), `Reply-To?`;
       - `Subject` (no deceptive prefixes; follow-ups use `Re:` only when truly replying in-thread);
       - `Message-ID: <uuidv7@mailbox-domain>` plus a custom `X-BF-Outbound-Id: <outbound_message_id>` header (some providers rewrite `Message-ID`; the stored `rfc822_message_id` is the one the provider reports after sending, BF-050), `In-Reply-To`/`References` for follow-ups;
       - `List-Unsubscribe: <https://…/u/{token}>` (+ `mailto:` variant if configured);
       - `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058);
       - optional `Feedback-ID` (configuration);
       - `text/plain` + minimal `text/html`; preview URL with `?r={outreachToken}`; footer from `FooterComposer` (identity, agency postal address, reason/source line, unsubscribe link, language-specific);
       - no tracking pixels or redirected links.
    4. **Send exactly once**: `MailboxProvider.sendRaw` with abort/timeout.
       - Success: `sent` + provider ids + commit capacity + `mailbox_daily_usage` + event.
       - **Crash or unknown outcome** (timeout after write, worker death during `sending` → lease expiry): the **reconciler** looks for the message in the mailbox's sent items. It first searches by our `Message-ID` (Gmail `rfc822msgid:`, Graph `internetMessageId` filter, IMAP `SEARCH HEADER Message-ID`). Because providers may rewrite that header, it falls back to a recipient + subject + time-window search whose candidates are confirmed by the `X-BF-Outbound-Id` header (fetched with message metadata). If found, mark `sent` with the provider ids; otherwise retry. Never resend without reconciliation.
       - Retryable errors: `failed` → backoff retry (max 3); permanent errors → final `failed` + reason.
  - **Side effects** (outbox subscribers, idempotent):
    - CRM status `qualified → contacted` (DOMAIN §3.1; `new` → `qualified` → `contacted` handled by a combined transition rule only if the workspace enables "auto-qualify on contact"; default on);
    - activity entry; realtime events;
    - `outreach.message.sent` for analytics (BF-058) and sequences (BF-053).
- **DSR integration**: register an outbound-messages data provider with the BF-055 DSR framework (export and erasure/anonymization of message content for a given email address, keeping compliance decision records as legally required minimal logs).
- **UI**:
  - Composer **Send** (BF-051) shows the inline compliance decision; the click sends, with an undo toast (10 s) and status chip updates in real time.
  - Listing row quick action "Send email" (opens the composer prefilled with the best contact + default template/AI draft; one more click to send).
  - **Outbox** page (`/outreach/outbox`): queued/scheduled/sending/failed/blocked tabs with reasons, actions (cancel, retry, reschedule, open decision), and mailbox filter.
  - **Approvals** page (`/outreach/approvals`): bulk runs with items (rendered preview, compliance badge, inline edit), approve/reject (single and bulk with count confirmation), skipped items with reasons and alternatives.
  - Business activity shows messages with status and the decision explanation (expandable).
- **Observability**:
  - Metrics: messages by status and mailbox, time in queue, send latency, reconciliations, blocked-at-send count by reason, approvals pending.
  - Alerts: send failure rate > 5% (5 min), any message in `sending` beyond lease + 10 min.

**Out of scope**
- Sequences (→ BF-053), inbound replies, threading of replies and bounce DSN parsing (→ BF-054), unsubscribe endpoints and pages (→ BF-055), deliverability auto-pause and DNS checks (→ BF-056).

## Requirements
### Functional
- **Invariant:** no message reaches `queued` without a persisted allowed decision; every `sent` message has an enqueue **and** a send-stage decision (architecture test + DB check constraint + hourly audit query from BF-049).
- Unsubscribe headers and footer are present on 100% of sent messages (test on composed MIME; the send fails closed if the unsubscribe token cannot be issued).
- A worker crash at any point never causes a duplicate send (chaos test with reconciliation).
- Undo within the window cancels the message; nothing reaches the provider.
### Non-functional
- One-click to `queued` P95 < 500 ms (draft already generated).
- The send worker respects per-mailbox intervals and domain throttles; 1,000 queued messages are processed without exceeding any cap (simulation test).

## Design
```
apps/api/src/modules/outreach/
├── domain/outbound/{outbound-message.ts, state-machine.ts, errors.ts, idempotency.ts}
├── application/outbound/{send-message.ts, cancel.ts, reschedule.ts, retry.ts, bulk/{start-bulk.ts, approve.ts,
│                          reject.ts}, manual-log.ts, queries/*, subscribers/{on-sent.ts, on-blocked.ts}}
├── infrastructure/outbound/{scheduler/tick.processor.ts, send.processor.ts, reconciler.ts, mime/composer.ts,
│                            tokens/outreach-token.ts, dsr/outbound.dsr-provider.ts, repositories/*}
└── interface/http/{messages.controller.ts, bulk.controller.ts, manual-log.controller.ts}
apps/web/src/features/outreach/{outbox/*, approvals/*, send-button.tsx, undo-toast.tsx}
```
- Patterns:
  - State Machine.
  - Transactional Outbox.
  - DB-backed scheduler with `SKIP LOCKED`.
  - Lease + reconciliation (exactly-once effect).
  - Reservation (capacity).
  - Shared kernel (`FooterComposer`).
  - Human-in-the-loop approval queue for bulk.

## Implementation plan
1. Contracts, tables + check constraints (`queued` requires `enqueue_decision_id`), state machine (TDD).
2. One-click API with compliance evaluation, render via `FooterComposer`, undo window; manual log.
3. Scheduler tick + send processor with re-evaluation, mailbox reservation, MIME composition with RFC 8058 headers.
4. Reconciler (Gmail/Graph/IMAP search by Message-ID) + chaos tests.
5. Bulk drafts + approval queue + auto-approve gating.
6. Side-effect subscribers, DSR provider, metrics/alerts.
7. UIs (send button + undo, outbox, approvals, activity); E2E with Mailpit.

## Testing
- **Unit:** state transitions; error taxonomy; MIME composer (headers present, `Message-ID` format, `In-Reply-To`/`References` for follow-ups, footer per locale); outreach token signing.
- **Integration** (Testcontainers + Mailpit + fake providers):
  - one-click → queued → sent; the message in Mailpit has `List-Unsubscribe` + `List-Unsubscribe-Post` and the footer;
  - suppression added after enqueue → `blocked` at send;
  - undo cancels before the provider is called;
  - no capacity → rescheduled (not failed);
  - provider timeout after send → reconciler finds it → `sent` once;
  - worker killed during `sending` → lease expiry → reconciliation → no duplicate;
  - bulk run → approvals → queued; auto-approve refused when the policy is unreviewed;
  - manual log refused for a suppressed contact;
  - authorization checks.
- **Architecture:** a message cannot be created in `queued` without a decision (DB constraint test) and the send path imports are restricted (BF-049 rules).
- **E2E:** listing → "Send email" → composer → send → undo → send again → status `sent` in activity; bulk flow through approvals.

## Acceptance criteria
- [x] Outbound aggregate with the DOMAIN §3.5 state machine and decision invariants (code, DB constraint; the architecture test is not written yet: testing paused).
- [x] One-click send with undo window, scheduling and idempotency; manual contact logging.
- [x] Scheduler + send worker with send-time re-evaluation, mailbox reservation, RFC 8058 headers, shared footer, no tracking.
- [x] Exactly-once send via leases and provider reconciliation (chaos tests not written yet: testing paused).
- [x] Bulk drafting with approval queue; auto-approve only when policy reviewed + permission + flag.
- [x] CRM/realtime side effects, DSR provider, metrics and alerts; outbox and approvals UIs.

## Agent prompt
```text
Implement BF-052 (One-click send and outbound pipeline).

Read first: AGENTS.md (§2 rule 7, §8), docs/adr/0006 and 0012, docs/compliance/outreach-compliance.md (§2, §3),
docs/DOMAIN.md (§3.5 outbound, §3.1 pipeline, §2 invariants), docs/ARCHITECTURE.md §12 and F5, BF-049 (evaluate,
decisions, architecture rules), BF-050 (MailboxSelector, capacity reservation, sendRaw), BF-051 (drafts,
FooterComposer), BF-055 (unsubscribe tokens/URLs, DSR framework). Skim BF-053, BF-054, BF-056 and BF-058.

Rules:
- The compliance gate is not optional: enqueue and send-time decisions, DB constraint, architecture rule.
- Fail closed: if the footer, unsubscribe token or decision cannot be produced, nothing is sent.
- Exactly-once effect: lease + reconciliation by Message-ID before any resend.
- No tracking pixels, no link redirects; plain-text first.
- Bulk sending always goes through approval unless every auto-send condition holds.

Verify: pnpm verify && pnpm test:int (incl. chaos tests) && pnpm e2e (outreach with Mailpit).
```

## References
- docs/DOMAIN.md §3.5 · ADR-0006 · ADR-0012 · docs/compliance/outreach-compliance.md
- RFC 8058 (one-click unsubscribe): https://www.rfc-editor.org/rfc/rfc8058 · RFC 5322 (Message-ID, In-Reply-To, References): https://www.rfc-editor.org/rfc/rfc5322 · Google sender requirements (one-click unsubscribe for bulk senders): https://support.google.com/a/answer/81126
