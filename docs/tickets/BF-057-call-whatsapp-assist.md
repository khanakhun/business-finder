---
id: BF-057
title: Call and WhatsApp assist — AI call scripts, best time to call, click-to-call, wa.me drafts, outcome logging, mobile call list
milestone: M4 Reach
epic: outreach
type: feature
priority: P1
size: M
depends_on: [BF-024, BF-040, BF-049, BF-051, BF-052]
blocks: []
areas: [web, api, ai]
---

# BF-057 — Call and WhatsApp assist: AI call scripts, best time to call, click-to-call, wa.me drafts, outcome logging, mobile call list

## Context
In Saint-Barthélemy many owners answer the phone or WhatsApp more readily than email. Some jurisdictions or contacts are also `manual_only` for email (BF-049), so calls and personal WhatsApp messages are the compliant alternative. The user's flow: "I see a website I want to create, I generate a preview, then I **call them to explain**" ([PRD FR-58](../PRD.md#66-outreach)).

This ticket makes calls and WhatsApp messages effective and logged without automating them. Humans dial and send. The system:
- prepares grounded scripts and messages;
- suggests the best time to call from opening hours;
- shows compliance for the phone/WhatsApp channel;
- records outcomes that drive the CRM.

Automated WhatsApp Business API messaging is out of scope; it requires opt-in and approved templates.

## Goal
A call workspace per business:
- AI call script (opener, observations, preview mention, qualifying questions, objection handling, next step) in FR/EN;
- best time to call;
- one-tap `tel:`;
- an outcome form that updates the pipeline, tasks and suppression.

WhatsApp assist drafts a short personal message with the preview link and opens `wa.me`. A mobile-first **call list** for the day completes the ticket.

## Scope
**In scope**
- **Call script** (`call-script.v1`, smart tier, structured):
  - Inputs: display facts, audit findings, review themes (general terms), preview site (URL + highlights), offer, contact role (generic line vs named person), language, partner's identity.
  - Output sections:
    - opener (identity, agency, reason for calling in one sentence, permission question "Do you have two minutes?");
    - 2–3 specific observations with fact/finding ids;
    - the preview mention ("We prepared a concept of what your site could look like; can I send you the link by WhatsApp or email?");
    - qualifying questions (who manages the website, bookings process, timeline);
    - objection handling (FR/EN: "We already have someone", "Too expensive", "Not now", "How did you get my number?" with source disclosure);
    - next step (meeting, send link, call back);
    - compliance reminders from the decision (e.g. "Respect the request to not be called again").
  - Validators: facts/literal checks (shared with BF-051), length per section.
  - Cached per (business, offer, locale, facts hash); regenerate on demand.
- **Best time to call** (pure):
  - Uses opening hours facts in the business timezone, avoiding category rush windows (data: restaurants/cafés 11:30–14:30 and 18:30–21:30; salons Saturday peaks; etc.), mornings preferred for retail.
  - Falls back to business-hours defaults by category.
  - Shows "Good time now" or the next good slot in the user's and the business's timezones.
- **Compliance**:
  - Phone and WhatsApp channel decisions from BF-049 (seeded `allowed_with_conditions`/`manual_only`), with reasons, displayed before dialing and drafting.
  - Blocked → no `tel:`/`wa.me` actions shown (with explanation); `do_not_contact` respected.
  - A "Do not call" outcome creates a phone-scope suppression.
- **Click-to-call and outcome logging**:
  - A `tel:` link (E.164) opens the phone or softphone; the call timer starts locally when the link is tapped.
  - The **outcome form** appears on return:
    - outcomes: no answer, voicemail left, spoke (interested / not interested / call back later with a date / asked for info by email / asked for info by WhatsApp), wrong number, do not call;
    - notes, duration (prefilled from the timer).
  - It creates a **manual contact log** via BF-052 (`channel: phone`, decision snapshot) with side effects:
    - interested → pipeline `engaged` + follow-up task;
    - call back → task at the date;
    - info by email → opens the composer (BF-051) prefilled with "as discussed on the phone" context (legitimate follow-up);
    - info by WhatsApp → WhatsApp assist;
    - wrong number → contact flagged invalid;
    - do not call → suppression (phone) + `do_not_contact` option.
- **WhatsApp assist**:
  - Shown when a WhatsApp-capable number exists (BF-026 `isWhatsApp`/`whatsappLinks`, or user-confirmed).
  - `whatsapp-message.v1` (fast tier) drafts ≤ 300 characters: greeting, identity + agency, reason, preview link with `?r=` token (BF-052 outreach token for attribution), an easy opt-out line ("Reply STOP and we won't write again" / « Répondez STOP… »).
  - Editable. **Open WhatsApp** builds `https://wa.me/<E164 digits>?text=<urlencoded>`.
  - The user confirms "Sent" → manual contact log (`channel: whatsapp`).
  - The reply-handling note reminds the user to log replies or outcomes (WhatsApp replies are not ingested).
- **Call list** (`/calls`, mobile-first, PWA-friendly):
  - Today's call tasks (BF-024) plus suggested businesses (tier A/B, phone available, good time now, not contacted in 14 days, compliance allows), ordered by priority and time window.
  - Each card: business, score tier, the preview link (open in the browser to show on a call), one-tap call, script (swipe), WhatsApp, quick outcome buttons.
  - Large touch targets; works offline for reading scripts (cached), with outcome logging queued until back online (IndexedDB queue + idempotent submit).
- **Business page**: a "Call" tab with the script, best time, history of manual contacts and outcomes.
- **Evals** (`call-script`, ≥ 30 cases; `whatsapp-message`, ≥ 30 cases; FR/EN): no fact violations, required sections present, length limits, judge rubric (natural spoken style, respect, specificity) ≥ 4.0.

**Out of scope**
- Telephony integrations (Twilio, Aircall, Ringover: possible follow-up via a `TelephonyProvider` port), call recording and transcription, WhatsApp Business API automation, SMS sending.

## Requirements
### Functional
- No `tel:`/`wa.me` action is offered when the channel decision is `blocked`; every logged contact stores the decision snapshot.
- Outcomes drive CRM changes deterministically (table-driven tests).
- Offline-queued outcomes sync exactly once.
### Non-functional
- Script generation P50 < 6 s; cached scripts open instantly.
- Call list usable on a 390 px-wide phone (Lighthouse mobile accessibility ≥ 95).

## Design
```
apps/api/src/modules/outreach/
├── domain/assist/{best-time.ts, outcome-policy.ts, rush-windows.yaml}
├── application/assist/{call-script.ts, whatsapp-draft.ts, log-outcome.ts, call-list.ts}
└── interface/http/{assist.controller.ts}
packages/ai/prompts/{call-script.v1.md, whatsapp-message.v1.md} · packages/ai/evals/{call-script, whatsapp-message}/*
apps/web/src/features/assist/{call-tab.tsx, script-view.tsx, outcome-form.tsx, whatsapp-composer.tsx,
                               call-list/{page.tsx, card.tsx, offline-queue.ts}}
```
- Patterns:
  - Strategy (best-time heuristics by category).
  - Policy table (outcome → effects).
  - Offline-first queue with idempotent sync.
  - Cache-aside for scripts.

## Implementation plan
1. Best-time domain logic with category rush windows (data) and timezone handling.
2. Call script and WhatsApp tasks + validators + evals.
3. Outcome policy + manual-log integration (BF-052) + suppression for do-not-call.
4. Business "Call" tab, WhatsApp composer.
5. Mobile call list with offline queue.
6. E2E on a mobile viewport.

## Testing
- **Unit:** best-time (hours spanning midnight, closed days, missing hours → defaults); outcome policy matrix; `wa.me` URL encoding (FR accents, emojis, line breaks).
- **Integration:** outcome "do not call" creates a phone suppression and blocks future phone decisions; "interested" sets `engaged` + task; script validators reject an invented award.
- **E2E (mobile viewport):** call list → open script → tap call (stubbed) → outcome "call back Thursday" → task created; WhatsApp draft → open `wa.me` link (asserted URL) → confirm sent → manual log.
- **Evals:** reports attached.

## Acceptance criteria
- [ ] Grounded FR/EN call scripts and WhatsApp drafts with validators and evals. (Scripts, drafts and validators
  done; the evals were not written or run while testing is paused.)
- [x] Best-time-to-call from opening hours and category rush windows.
- [x] Compliance-aware click-to-call and `wa.me` with outcome logging driving CRM, tasks and suppression.
- [x] Mobile-first call list with offline outcome queue; business Call tab.

## Agent prompt
```text
Implement BF-057 (Call and WhatsApp assist).

Read first: AGENTS.md, docs/compliance/outreach-compliance.md (calls), docs/conventions/ai-engineering.md (§5, §11),
BF-049 (phone/WhatsApp decisions), BF-052 (manual contact logs, outreach tokens), BF-051 (shared validators, composer
prefill), BF-040 (facts incl. hours), BF-024 (tasks, pipeline).

Rules:
- Humans dial and send; the system prepares, checks compliance and logs. No automated WhatsApp/SMS sending.
- Scripts and messages are grounded in facts, short, respectful, natural spoken FR/EN; include source disclosure for
  "how did you get my number?".
- Blocked channels expose no call/WhatsApp actions; do-not-call creates a suppression.
- Mobile-first, offline-tolerant call list.

Verify: pnpm verify && pnpm test:int && pnpm e2e (assist, mobile viewport); attach eval reports.
```

## References
- docs/compliance/outreach-compliance.md · BF-049 · BF-052
- WhatsApp click-to-chat: https://faq.whatsapp.com/5913398998672934 · RFC 3966 (tel URI): https://www.rfc-editor.org/rfc/rfc3966
