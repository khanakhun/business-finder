---
id: BF-054
title: Reply ingestion, bounce/auto-reply parsing, AI triage, actions and unified inbox
milestone: M4 Reach
epic: outreach
type: feature
priority: P0
size: L
depends_on: [BF-013, BF-049, BF-050, BF-051, BF-052]
blocks: [BF-053, BF-056, BF-058, BF-060]
areas: [api, worker, web, ai]
---

# BF-054 — Reply ingestion, bounce/auto-reply parsing, AI triage, actions and unified inbox

## Context
Replies are where money is made, and where mistakes hurt: missing an "I'm interested", or emailing again someone who said "stop" ([PRD J5, FR-55](../PRD.md#66-outreach), [ARCHITECTURE F6](../ARCHITECTURE.md#f6--reply-triage)). The partners' mailboxes also contain their **private email**. We must therefore ingest **only** messages that belong to outreach conversations and ignore everything else, without storing it.

Mailbox transports and sync primitives exist (BF-050), outbound messages and threads exist (BF-052), drafts and reply templates exist (BF-051), and suppression and the compliance gate exist (BF-049). This ticket adds:
- inbound sync and thread matching;
- deterministic bounce (DSN) and auto-reply detection;
- AI triage with confidence;
- deterministic actions (stop sequences, pipeline, tasks, suppression);
- a unified inbox with suggested replies.

## Goal
Near-real-time ingestion of outreach replies across Gmail, Microsoft 365 and IMAP mailboxes, with privacy-preserving filtering. It parses bounces and auto-replies, triages human replies into DOMAIN classes with entities and summaries, applies safe automatic actions, and gives the team a unified inbox with sanitized rendering, triage correction and AI-suggested replies sent through the compliant pipeline.

## Scope
**In scope**
- **Sync** (`outreach.sync` queue, per mailbox):
  - Push where enabled: Gmail watch + Pub/Sub push endpoint, Graph change notifications, each with validation tokens/signatures and subscription renewal (BF-050).
  - Otherwise polling every 2 minutes (configurable), and always a safety poll every 15 minutes.
  - Uses `MailboxProvider.syncChanges(cursor)`; cursors persisted after successful processing (at-least-once, deduplicated).
  - Sync health recorded per mailbox (`last_success_at`, `lag`, `errors`) for BF-053's guard and BF-056's dashboard.
- **Privacy filter** (before anything is stored; pure function + data lookups). A message is **relevant** only if at least one holds:
  1. `In-Reply-To`/`References` contains one of our outbound RFC 822 Message-IDs;
  2. the provider thread/conversation id matches one of our threads;
  3. it is a DSN or bounce referencing our Message-ID (in the attached original headers);
  4. it was sent to our unsubscribe mailto address (if enabled);
  5. fallback: `From` equals a contact we emailed from this mailbox in the last 60 days **and** the subject matches our thread subject (normalized `Re:`/`RE :`/`TR:`/`Fwd:` prefixes).

  Irrelevant messages are dropped in memory and only counted (metrics). No metadata is stored.
- **Tables**:
  - `inbound_messages`:
    - provenance: `id`, `organization_id`, `mailbox_id`, `thread_id`, `outbound_message_id?` (direct parent), `provider_message_id` (unique per mailbox), `rfc822_message_id`, `in_reply_to`, `references` text[];
    - addressing and content: `from_email`, `from_name?`, `to`, `cc`, `subject`, `received_at`, `body_text` (sanitized, ≤ 100 KB), `body_html_sanitized?`, `snippet`, `attachments` jsonb (metadata only; not stored by default);
    - parsing results: `kind` (`human|auto_reply|bounce|unsubscribe_mailto`), `dsn` jsonb (status code, action, diagnostic, recipient), `auto_reply` jsonb (return date if parsed);
    - triage: `triage` jsonb (class, confidence, entities, summary, language, model/prompt version), `triage_status` (`pending|done|needs_human|corrected`), `corrected_class?`, `corrected_by?`;
    - handling: `status` (`new|read|handled|snoozed`), `assigned_to?`, `snoozed_until?`, timestamps;
    - `raw_storage_key?` (encrypted object, 90-day retention, for debugging/DSR).
  - `email_threads` (from BF-052) gains `last_inbound_at`, `unread_count`, `latest_triage_class`.
- **Parsing** (deterministic first):
  - **DSN** (`multipart/report; report-type=delivery-status`, RFC 3464):
    - extracts the original Message-ID, recipient, action and status;
    - **hard bounce** (5.x.x permanent) → outbound `bounced`, contact verification `invalid`, suppression (scope email, reason `hard_bounce`), event `outreach.message.bounced`;
    - **soft bounce** (4.x.x) → recorded; three soft bounces in 7 days count as a hard bounce;
    - provider-specific non-standard bounces handled by heuristics (Gmail/Outlook formats) with fixtures.
  - **Auto-reply** (RFC 3834 `Auto-Submitted: auto-replied`, `X-Autoreply`, `X-Autorespond`, `Precedence: auto_reply|bulk|junk`, common OOO subjects and phrases FR/EN):
    - `kind = auto_reply`;
    - return date extracted (regex FR/EN date formats; LLM fallback in triage);
    - event `outreach.reply.triaged` with class `auto_reply`.
  - **Human replies**: quoted history stripped for triage (reply-parsing heuristics, FR/EN separators like « Le … a écrit : », "On … wrote:", Outlook headers). The full sanitized text is kept for display.
- **Event on receipt**: `outreach.reply.received` (thread, business, contact, kind) is emitted **before** triage, so sequences stop within seconds (BF-053). Outbound status → `replied`; thread status → `replied`.
- **AI triage** (`reply-triage.v1`, fast tier, structured):
  - Input: stripped reply text wrapped as `<untrusted_data source="email">`, our previous message summary (our own content, trusted), business name, locale.
  - Output:
    - `class` ∈ {`interested`, `question`, `not_now`, `referral`, `unsubscribe`, `negative`, `auto_reply`};
    - `confidence`, `language`, a one-line `summary` in the user's UI language;
    - `entities` (phone, preferred time/date, referral name/email/role, price question, meeting request);
    - `suggestedNextAction`;
    - `injectionSuspected` flag.
  - Confidence < 0.7 or `injectionSuspected` → `triage_status = needs_human` (no automatic actions except the always-safe ones below).
  - Batched when many replies arrive (≤ 10 per call); results cached by message hash.
- **Actions** (deterministic policy over triage + parsing; idempotent subscribers):
  - **Always**, for any human reply: stop sequences (already on receipt); in-app notification to the business owner (high priority for `interested`/`question`).
  - **Unsubscribe intent**:
    - a deterministic keyword detector (FR/EN/NL/ES phrases: "désinscrire", "ne plus recevoir", "stop", "unsubscribe", "remove me", "afmelden", …) **or** an AI class of `unsubscribe` with confidence ≥ 0.5 → **suppress immediately** (scope email; `source = reply`);
    - favour suppression when uncertain;
    - no confirmation email is sent;
    - the thread is labelled.
  - `interested` / `question` → pipeline → `engaged` (DOMAIN §3.1); task "Reply to {name}" due today; a suggested reply draft is generated.
  - `not_now` → task "Follow up in {N} months" (date extracted or 3 months default); pipeline unchanged; no automatic emails.
  - `referral` → task with the referral details; a new contact suggestion (requires human confirmation; compliance applies to any outreach).
  - `negative` → suggest "Mark as lost" and "Do not contact" (one click; not automatic, except the stop already done).
  - `auto_reply` → sequences rescheduled (BF-053).

  Every action is recorded in the activity timeline with the triage explanation.
- **Suggested replies**: BF-051 drafting in reply mode, using reply templates per class plus thread context (our messages + the prospect's reply, wrapped as untrusted) and facts. Sending a reply goes through BF-052 with `purpose = reply` (in-thread, same mailbox, compliance-evaluated: replying to a person who wrote to us is allowed unless suppressed).
- **Unified inbox UI** (`/inbox`):
  - Thread list: filters (triage class, mailbox, unread, needs human, assigned to me, business tier), search, keyboard navigation (j/k, e = handled, a = assign, s = snooze).
  - Thread view:
    - messages in order (outbound + inbound);
    - inbound HTML rendered **sanitized** (`sanitize-html`/DOMPurify server-side) in a sandboxed iframe with a strict CSP; remote images blocked by default (privacy/tracking), "show images" per message.
  - Triage chip with summary, entities and confidence. **Correcting the class** stores feedback (`corrected_class`), re-runs the action policy where safe, and adds the case to an eval feedback set.
  - Business sidebar: score, pipeline, preview views, contacts, compliance status.
  - Suggested reply editor (regenerate, translate) → Send via BF-052 (undo window applies).
  - Assign, snooze, mark handled; unread counts in the navigation; realtime updates.
- **DSR**: register an inbound-messages data provider with the BF-055 framework (export and erasure/anonymization).
- **Evals** (`packages/ai/evals/reply-triage/*.jsonl`, ≥ 120 synthetic replies FR/EN across classes, including sarcasm, mixed intents, forwarded messages and injection attempts):
  - macro-F1 ≥ 0.90;
  - **unsubscribe recall ≥ 0.99** (combined with the keyword detector);
  - `interested` precision ≥ 0.90;
  - injection attempts never produce automatic actions beyond the always-safe set.

**Out of scope**
- Deliverability dashboards and auto-pause thresholds (→ BF-056), call assist (→ BF-057), attachments storage, a shared team inbox outside outreach threads (privacy by design).

## Requirements
### Functional
- Only outreach-related messages are stored (tests with mixed mailbox fixtures prove irrelevant messages leave no trace).
- A human reply stops sequences within 1 minute of arrival (push) or within the polling interval (poll).
- Unsubscribe replies always suppress, even when triage fails (deterministic detector path).
### Non-functional
- Sync lag P95 < 2 min (push) / < 5 min (poll); triage P95 < 10 s after receipt.
- Inbound HTML is never rendered unsanitized; remote content is blocked by default.

## Design
```
apps/api/src/modules/outreach/
├── domain/inbound/{relevance-filter.ts, dsn-parser.ts, auto-reply-detector.ts, quote-stripper.ts,
│                   unsubscribe-detector.ts, action-policy.ts}
├── application/inbound/{ingest.ts, triage.ts, apply-actions.ts, correct-triage.ts, suggest-reply.ts,
│                        queries/inbox.ts}
├── infrastructure/inbound/{processors/{sync.processor.ts, triage.processor.ts}, push/{gmail-push.controller.ts,
│                           graph-notifications.controller.ts}, sanitizer.ts, dsr/inbound.dsr-provider.ts,
│                           repositories/*}
└── interface/http/{inbox.controller.ts}
packages/ai/prompts/reply-triage.v1.md · packages/ai/evals/reply-triage/*
apps/web/src/features/inbox/{inbox-page.tsx, thread-list.tsx, thread-view.tsx, message-frame.tsx,
                             triage-chip.tsx, reply-editor.tsx, business-sidebar.tsx}
```
- Patterns:
  - Pipes and Filters (sync → relevance → parse → store → events → triage → actions).
  - Specification (relevance, action policy).
  - Idempotent consumers.
  - Human-in-the-loop correction with a feedback dataset.
  - Defense in depth for untrusted content (sanitize + sandbox + CSP).

## Implementation plan
1. Relevance filter, DSN parser, auto-reply detector, quote stripper and unsubscribe detector (pure, fixture-driven: real-world anonymized samples from Gmail/Outlook/OVH/Zoho formats, synthetic content).
2. Sync processors (poll + push endpoints with validation), cursors, health metrics.
3. Ingestion, events on receipt, outbound/thread status updates; hard/soft bounce handling + suppression.
4. Triage task (prompt, structured output, batching, caching) + evals.
5. Action policy subscribers (pipeline, tasks, suppression, notifications, sequences) + correction flow.
6. Suggested replies (BF-051 reply mode) + reply sending via BF-052.
7. Inbox UI with sanitization/sandboxing; DSR provider; E2E.

## Testing
- **Unit** (fixture-driven):
  - relevance filter (mixed mailbox: personal emails ignored);
  - DSN parsing (≥ 15 formats);
  - auto-reply detection (FR/EN headers and phrases);
  - quote stripping (Gmail/Outlook/Apple Mail FR/EN);
  - unsubscribe detector (multi-language, negations like "don't unsubscribe me" handled conservatively);
  - action policy matrix.
- **Integration:**
  - Mailpit/GreenMail IMAP: send outreach → inject a reply → ingest → sequence stopped → triage (fake LLM) → pipeline `engaged` + task + notification;
  - a hard bounce DSN suppresses the email and marks it bounced;
  - an OOO reply reschedules the sequence;
  - an unsubscribe reply suppresses even when the triage provider is down;
  - irrelevant messages are not stored;
  - push endpoint validation rejects forged notifications.
- **E2E:** inbox shows the triaged thread; correct the class; send a suggested reply in-thread (Mailpit shows the correct headers).
- **Evals:** report attached (macro-F1, unsubscribe recall, injection behaviour).

## Acceptance criteria
- [x] Poll sync per mailbox with cursors and health; privacy filter stores only outreach-related messages (push endpoints for Gmail Pub/Sub and Graph notifications are a follow-up).
- [x] Deterministic DSN (hard/soft) and auto-reply parsing with suppression; the auto-reply return date rides on `outreach.reply.received` for BF-053's rescheduling.
- [x] AI triage with confidence, entities, summary and injection awareness.
- [ ] Evals meet thresholds (not done: the ≥ 120-reply eval set is not written yet, testing is paused).
- [x] Deterministic action policy (stop, pipeline, tasks, suppression, notifications) with correction feedback.
- [x] Unified inbox with sanitized sandboxed rendering, suggested replies sent through BF-052, keyboard workflow.
- [x] DSR provider registered; metrics for sync lag, triage latency and classes.

## Agent prompt
```text
Implement BF-054 (Reply ingestion, triage and inbox).

Read first: AGENTS.md, docs/ARCHITECTURE.md (§12, F6), docs/DOMAIN.md (Reply triage classes, §3.5, §4 events),
docs/conventions/security.md (§3 sanitization, §6 untrusted LLM input, §7 privacy), docs/conventions/ai-engineering.md
(§6, §9), BF-050 (syncChanges/push), BF-052 (threads, outbound statuses, reply sending), BF-051 (reply drafting),
BF-049 (suppression), BF-055 (DSR framework). Skim BF-053 (sequence stops) and BF-056 (bounce metrics).

Rules:
- Privacy first: decide relevance before storing anything; irrelevant messages leave no trace.
- Deterministic parsing before AI; unsubscribe detection must work without the LLM and favour suppression.
- Email content is untrusted: wrap for the LLM, sanitize for display, sandbox rendering, block remote images.
- Emit reply-received before triage so sequences stop immediately; all consumers idempotent.

Verify: pnpm verify && pnpm test:int && pnpm e2e (inbox); pnpm eval --filter=@bf/ai -- reply-triage (attach report).
```

## References
- docs/ARCHITECTURE.md F6 · docs/DOMAIN.md · BF-050 · BF-052
- RFC 3464 (DSN): https://www.rfc-editor.org/rfc/rfc3464 · RFC 3834 (auto-responses): https://www.rfc-editor.org/rfc/rfc3834 · RFC 3463 (enhanced status codes): https://www.rfc-editor.org/rfc/rfc3463 · Gmail push: https://developers.google.com/workspace/gmail/api/guides/push · Graph change notifications: https://learn.microsoft.com/en-us/graph/change-notifications-overview
