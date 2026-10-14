---
id: BF-053
title: Sequences — multi-step follow-ups in business days, stop conditions, A/B variants, preview-view conditions
milestone: M4 Reach
epic: outreach
type: feature
priority: P1
size: L
depends_on: [BF-024, BF-035, BF-049, BF-051, BF-052, BF-054]
blocks: [BF-058]
areas: [api, worker, web]
---

# BF-053 — Sequences: multi-step follow-ups in business days, stop conditions, A/B variants, preview-view conditions

## Context
Most positive replies come after a polite follow-up, but follow-ups are also where outreach becomes spam. A sequence must therefore:
- send a small number of well-spaced, in-thread follow-ups from the same mailbox;
- **stop immediately** on any reply, bounce, unsubscribe, suppression, lead or pipeline change;
- honour compliance at every step (each send goes through BF-052, which evaluates compliance again);
- never run on a mailbox whose reply sync is not working ([PRD FR-54](../PRD.md#66-outreach), [DOMAIN §3.6](../DOMAIN.md#36-sequence-enrollment)).

Our differentiator is the preview site. Follow-ups can therefore adapt to whether the prospect opened the preview: a cookieless view on our own domain, attributed by the outreach token, with no email open tracking.

## Goal
Versioned sequence definitions:
- steps (email or manual task) with waits in business days and per-step conditions;
- A/B variants with deterministic assignment;
- safety limits.

Enrollments run on a DB-backed scheduler with event-driven stop conditions, out-of-office rescheduling, approval-aware sending, preview-view attribution, and builder/enrollment/statistics UIs.

## Scope
**In scope**
- **Tables**:
  - `sequences`: `id`, `organization_id`, `name`, `offer`, `status` (`draft|active|archived`), `head_version`, timestamps.
  - `sequence_versions` (immutable once used): `id`, `sequence_id`, `version`, `settings` jsonb, `steps` jsonb, `created_by`, `created_at`.
    - Settings: `calendarId` (business days + holidays), `maxEmails` (≤ 4), `minGapBusinessDays` (≥ 2), stop conditions (all on by default, some toggleable), `approval` (`always|auto_when_permitted`).
    - Step fields:
      - `id`, `order`, `wait` (`businessDays`, `preferredLocalTime?`);
      - `kind` (`email|task_call|task_whatsapp|task_custom`);
      - for email: `templateId` or `ai` with instructions; `threading` (`reply_in_thread|new_thread`); `variants[]` (`id`, `weight`, template or instructions, subject strategy);
      - `condition?` (`previewViewed|previewNotViewed|always`);
      - `skipIf?` (e.g. contact has no verified email → skip to tasks).
  - `sequence_enrollments`: `id`, `organization_id`, `sequence_version_id`, `business_id`, `contact_id`, `mailbox_id` (sticky after the first send), `status` (DOMAIN §3.6: `active|paused|completed|stopped`), `current_step_index`, `next_run_at`, `variant_assignments` jsonb, `stop_reason?`, `stopped_at?`, `enrolled_by`, timestamps.
    - Partial unique index: one **active or paused** enrollment per (org, business), so a business is never double-sequenced.
  - `enrollment_events`: step executed / skipped / stopped / rescheduled, with reason (audit trail).
  - `outbound_message_views`: (`outbound_message_id`, `first_viewed_at`, `views`). Fed by extending the BF-035 views ingestion to accept the `r` outreach token (validated) next to `c`. Attribution only: no personal data.
- **Domain**:
  - `SequenceDefinition` validation: limits, gaps, at least one email step, variant weights sum to 100, conditions valid.
  - `Enrollment` aggregate with the DOMAIN §3.6 state machine.
  - `BusinessCalendar`: business days per workspace calendar (weekends + holiday dataset FR/BL/US, configurable) and recipient timezone.
  - `VariantAssigner`: deterministic `hash(enrollmentId, stepId)` → weighted bucket.
  - **Stop policy** (pure function `shouldStop(enrollment, facts) → reason | null`, evaluated on every tick and on events):
    - human reply on the thread;
    - hard bounce;
    - unsubscribe or suppression;
    - `do_not_contact`;
    - lead captured;
    - pipeline status in {`engaged`, `meeting`, `proposal`, `won`, `lost`, `disqualified`};
    - manual stop;
    - contact invalidated;
    - mailbox removed;
    - compliance `blocked` at evaluation.
- **Execution** (DB-backed scheduler; the `outreach.tick` from BF-052 also claims due enrollments with `SKIP LOCKED`):
  1. Re-evaluate the stop policy (stop with reason if needed).
  2. Check step conditions (`previewViewed` = any view attributed to a previous outbound message of this enrollment since it was sent).
  3. **Email step**:
     - create a draft (template or AI via BF-051, reply mode for in-thread follow-ups: same mailbox, `In-Reply-To`/`References`, subject `Re: <original>`; legitimate because the thread exists);
     - then submit via the BF-052 send command;
     - sequences with `approval = always`, or where auto-send isn't permitted (BF-049 `isAutoSendPermitted` + `autoSend` flag + `outreach:auto_send`), create `pending_approval` messages in the approvals queue. The enrollment waits; approvals have an expiry after which the step is skipped with a reason.
  4. **Task steps**: create CRM tasks (BF-024) with a call or WhatsApp script link (BF-057 when available), due at the scheduled time.
  5. Advance `current_step_index` and compute `next_run_at` (business days + preferred local time + mailbox window).
  6. Complete after the last step.
- **Event subscribers** (idempotent, near-real-time stop; do not wait for the tick):
  - `outreach.reply.received` (BF-054 emits it on receipt, before triage) → stop (`replied`) unless the triage later says `auto_reply`;
  - `outreach.reply.triaged` with `auto_reply` → resume and reschedule to the extracted return date + 1 business day (or +5 business days if unknown);
  - `outreach.message.bounced` (hard) → stop;
  - `contact.suppressed` → stop all enrollments for that contact/business;
  - `site.lead.captured` → stop (`converted`);
  - `org_business.status_changed` → stop when the status is in the stop set.
- **Safety rails**:
  - Global per-workspace cap of follow-ups per day (configuration).
  - Sequences auto-advance only if the enrollment's mailbox has **healthy reply sync** (BF-054 health: last successful sync < 15 min). Otherwise enrollments pause with reason `reply_sync_unhealthy`, and the owner is notified.
  - Editing an active sequence creates a new version. Existing enrollments stay on their version unless explicitly migrated (with a diff preview).
- **APIs** (permission `outreach:send`; managing sequences requires `templates:manage` or `settings:manage`):
  - `/v1/sequences` CRUD + versions + `POST /v1/sequences/:id/activate|archive`.
  - `POST /v1/sequences/:id/enroll`:
    - accepts `{ items: [{ businessId, contactId }] }` (≤ 100) or `{ fromMessageId }` to attach a sequence after a first send (PRD J4);
    - runs a compliance preview per item; blocked items are reported, not enrolled.
  - `POST /v1/enrollments/:id/pause|resume|stop`, `GET /v1/enrollments?businessId=`.
  - `GET /v1/sequences/:id/stats`: per step and variant — sent, replies (positive/neutral/negative from triage), bounces, unsubscribes, preview views, with Wilson 95% intervals; "insufficient data" markers below n = 30.
- **UI**:
  - **Sequence builder**: step list with waits ("+3 business days at 09:30 recipient time"), step kind, template/AI instructions, variants (weights), conditions, threading; live validation of safety rails; a preview timeline for a sample business ("Mon 13 → Thu 16 → Wed 22").
  - **Composer integration**: after send, "Attach follow-up sequence" (default sequence preselected).
  - **Business page**: enrollment timeline (past steps with messages, next step date, variant), pause/resume/stop.
  - **Sequences list** with stats; per-step/variant stats view (bar charts + table alternatives).
  - **Approvals** (BF-052) shows sequence context ("Step 2 of 'Website redesign FR'").
- **Seeded sequences** (EN/FR):
  - "Preview follow-up": step 1 is the first touch (sent manually via the composer); step 2 waits 3 business days, then a follow-up whose variant depends on preview viewed vs not; step 3 waits 5 business days, then a polite close.
  - "Audit-led" variant without a preview.

**Out of scope**
- Inbound sync and triage (→ BF-054), deliverability auto-pause (→ BF-056), call/WhatsApp scripts (→ BF-057), automatic winner selection for A/B (manual decision with stats).

## Requirements
### Functional
- A human reply stops the enrollment within one minute of receipt (event-driven), before any further step can send.
- Business-day waits and preferred times are computed in the recipient's timezone with holidays; tests cover month ends and DST transitions in mailbox timezones.
- One active or paused enrollment per business per workspace.
### Non-functional
- Tick processing of 1,000 due enrollments < 30 s; idempotent under concurrent workers.
- Every executed, skipped or stopped step is auditable with its reason.

## Design
```
apps/api/src/modules/outreach/
├── domain/sequences/{sequence-definition.ts, enrollment.ts, state-machine.ts, stop-policy.ts, business-calendar.ts,
│                     variant-assigner.ts, conditions.ts}
├── application/sequences/{crud/*.ts, enroll.ts, pause-resume-stop.ts, execute-step.ts, stats.ts,
│                          subscribers/{on-reply.ts, on-triaged.ts, on-bounce.ts, on-suppressed.ts, on-lead.ts,
│                                       on-status-changed.ts}}
├── infrastructure/sequences/{tick-claimer.ts, repositories/*, calendars/*.json}
└── interface/http/{sequences.controller.ts, enrollments.controller.ts}
apps/web/src/features/outreach/sequences/{builder/*, list.tsx, stats.tsx, enrollment-timeline.tsx}
```
- Patterns:
  - State Machine (enrollment).
  - Specification (stop policy, conditions).
  - Strategy (step kinds).
  - DB-backed scheduler.
  - Immutable versions.
  - Deterministic hashing for experiments.

## Implementation plan
1. Contracts and definition validation; calendar and variant assigner (TDD with a fake clock and timezones).
2. Tables, enrollment state machine, stop policy (pure, table-driven tests).
3. Execution in the tick (email via the BF-051/BF-052 commands, tasks via BF-024), approvals integration.
4. Event subscribers (reply, triage, bounce, suppression, lead, status) + reply-sync health guard.
5. Views attribution extension (`r` token in the BF-035 ingestion) + conditions.
6. Stats with intervals; UIs; seeded sequences; E2E with Mailpit + simulated replies.

## Testing
- **Unit:** business-day arithmetic (holidays, weekends, DST, month ends), stop policy matrix, variant assignment distribution (χ² sanity on 10k ids), definition validation.
- **Integration:**
  - enroll → step 2 sends in-thread after 3 business days (fake clock) from the same mailbox with correct `In-Reply-To`;
  - a reply received → enrollment stopped before step 2;
  - auto-reply → rescheduled;
  - suppression mid-sequence → stopped and queued message cancelled (BF-052 subscriber);
  - unhealthy reply sync → paused with notification;
  - approval-required step waits, then expires, then is skipped;
  - preview-view condition picks the right variant;
  - concurrency: two workers never execute the same step twice.
- **E2E:** send the first email → attach the sequence → simulate time → follow-up appears in approvals → approve → Mailpit has the in-thread follow-up → simulate a reply → enrollment stopped.

## Acceptance criteria
- [ ] Versioned sequence definitions with safety rails, business-day waits, conditions and A/B variants.
- [ ] Enrollment state machine with event-driven stops (reply, bounce, suppression, lead, status) and out-of-office rescheduling.
- [ ] Execution through BF-051/BF-052 (in-thread, sticky mailbox, approvals) and CRM tasks for manual steps.
- [ ] Reply-sync health guard; preview-view attribution; stats with confidence intervals.
- [ ] Builder, enrollment timeline, stats UIs; seeded EN/FR sequences; E2E passes.

## Agent prompt
```text
Implement BF-053 (Sequences).

Read first: AGENTS.md, docs/DOMAIN.md (§3.6 enrollment, §3.1 pipeline, §4 events), docs/adr/0006 (DB-backed
scheduler), docs/compliance/outreach-compliance.md, BF-052 (send command, approvals, tick), BF-051 (drafts/reply mode),
BF-054 (reply events, triage, sync health), BF-049 (auto-send permission), BF-035 (views ingestion), BF-024 (tasks).

Rules:
- Stopping is more important than sending: event-driven stops, re-check at every step, fail closed when reply sync is
  unhealthy.
- Every email goes through BF-052 (compliance at enqueue and send); no direct provider calls.
- Business-day math in recipient timezone with holidays; exhaustive tests.
- Versions are immutable once used; experiments use deterministic assignment and honest statistics.

Verify: pnpm verify && pnpm test:int && pnpm e2e (sequences with Mailpit and simulated replies).
```

## References
- docs/DOMAIN.md §3.6 · ADR-0006 · ADR-0012 · BF-052 · BF-054
- Wilson score interval: https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval · RFC 3834 (auto-responses): https://www.rfc-editor.org/rfc/rfc3834
