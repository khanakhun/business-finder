---
id: BF-056
title: Deliverability guardrails — DNS authentication checks, auto-pause thresholds, kill switch, health dashboard
milestone: M4 Reach
epic: outreach
type: feature
priority: P1
size: M
depends_on: [BF-050, BF-052, BF-054]
blocks: []
areas: [api, worker, web]
---

# BF-056 — Deliverability guardrails: DNS authentication checks, auto-pause thresholds, kill switch, health dashboard

## Context
A few bad days can burn a sending domain for months. Mailbox providers require authenticated mail (SPF, DKIM, DMARC alignment), low complaint rates and easy unsubscribe ([PRD FR-57](../PRD.md#66-outreach)). Volumes here are small (tens of emails per day per mailbox), but reputation is per domain and per mailbox. The system must therefore:
- check authentication before sending;
- stop automatically when signals turn bad;
- give the team a clear health view with fix instructions.

Send counters and capacity come from BF-050. Bounce, auto-reply and unsubscribe signals come from BF-052, BF-054 and BF-055. The mailbox lifecycle already has a `paused` state (DOMAIN §3.7).

## Goal
For each sending domain and mailbox:
- DNS checks: SPF, DKIM, DMARC, alignment, MX, optional MTA-STS/TLS-RPT/BIMI, with fix instructions;
- optional blocklist checks;
- rolling health metrics with **auto-pause** rules;
- a workspace **kill switch**;
- pre-send readiness gating;
- a deliverability dashboard and weekly digest.

## Scope
**In scope**
- **DNS authentication checks** (`DeliverabilityService.checkDomain(domain, mailbox)`):
  - Run via DNS-over-HTTPS or system resolver with timeouts.
  - Results cached for 6 hours and re-run daily, and on demand.
  - **SPF**:
    - record present and unique;
    - includes the mailbox provider (Google: `_spf.google.com`; Microsoft: `spf.protection.outlook.com`; SMTP provider from a configurable presets table);
    - ≤ 10 DNS lookups (recursive count);
    - policy qualifier (`~all`/`-all`).
  - **DKIM**:
    - provider selectors probed (Google `google._domainkey`, Microsoft `selector1`/`selector2._domainkey`, configurable custom selectors);
    - key present, key length ≥ 1024 (recommend 2048).
  - **DMARC**: `_dmarc` record present, policy (`none|quarantine|reject`), `rua` present (recommendation), alignment mode.
  - **Alignment** (with a real test message): the From domain aligns with DKIM `d=` or the SPF envelope domain. The check sends a test to a Mailpit or self address and parses `Authentication-Results` where possible (Gmail/Graph adapters can read the received copy). Optional and on demand.
  - **MX**, plus **MTA-STS/TLS-RPT/BIMI** (informational).
  - Outcome per check: `pass|warn|fail`, with **fix instructions** (exact record values to add for the provider, explained in EN/FR).
- **Readiness gate**: mailboxes whose domain fails SPF **or** DKIM **or** has no DMARC record cannot leave `connected`/`warming` for automatic sends. BF-050 selector filters them out. Manual one-click sends show a blocking warning with a link to the fix. The owner can explicitly override per mailbox (audited, reason required) for transactional-like personal mail.
- **Optional blocklist checks** (feature flag; providers configurable):
  - domain and sending IP (for SMTP mailboxes) against DNSBLs, e.g. Spamhaus via its Data Query Service with a key;
  - the **preview sites domain** (`SITES_BASE_DOMAIN`) checked too, since every email links to it.

  Verify each list's usage terms (many forbid queries via public resolvers or commercial use without a key) and document them in configuration.
- **Rolling health metrics** (per mailbox and per sending domain; computed from events; windows of 24 h, 7 days, and the last 50 sends):
  - sends;
  - hard and soft bounces;
  - unsubscribes (one-click + reply);
  - negative replies;
  - "spam" complaints where detectable (Microsoft JMRP/SNDS out of scope; replies containing "spam" classified as negative + unsubscribe);
  - provider deferrals and throttles (4xx, rate limits);
  - auto-reply share;
  - positive reply rate (context only).
- **Auto-pause rules** (data-driven, `deliverability_rules` defaults; workspace may tighten only):
  - hard bounce rate > 3% over the last 50 sends (min 20 sends) → pause the mailbox;
  - 3 hard bounces within 24 h on a new mailbox (warming) → pause;
  - unsubscribe rate > 5% over 7 days (min 40 sends) → warning; > 10% → pause;
  - provider quota or "suspicious activity" errors → pause until the next day + notify;
  - authentication regression (DNS check turns `fail`) → pause automatic sends.

  Pausing:
  - transitions the mailbox to `paused` with a reason;
  - **reschedules** queued messages (not lost);
  - notifies owners (in-app + email);
  - resuming requires passing checks plus a confirmation (BF-050 resume).
- **Kill switch**: workspace-level "Stop all sending" (owner/admin):
  - immediately prevents new sends (send processor checks a cached flag before each send);
  - pauses sequences (enrollments `paused` with reason `kill_switch`);
  - shows a banner across the app.

  Resume requires a confirmation and a reason; audited.
- **Warm-up guidance**: integrates with the BF-050 ramp. Shows planned vs actual volume and recommends slowing down when warnings appear (no automatic warm-up networks).
- **Deliverability dashboard** (`/outreach/deliverability`):
  - domain cards with the authentication checklist (pass/warn/fail with fix instructions and "Re-check");
  - mailbox cards: status, cap and ramp, 7- and 30-day trends (sends, bounces, unsubscribes, replies), auto-pause history;
  - blocklist status;
  - kill switch;
  - links to external tools (Google Postmaster Tools, Microsoft SNDS) with setup instructions.
  - Weekly digest email to owners summarizing health and recommendations (opt-out per user).
- **Metrics and alerts**: `mailbox_paused_total{reason}`, bounce rates gauges, DNS check failures; alerts to the ops channel (BF-061) on auto-pause events and kill-switch activation.

**Out of scope**
- Inbox placement seed testing (possible follow-up), dedicated IP management, third-party warm-up services (not supported by design).

## Requirements
### Functional
- Auto-pause triggers within one minute of the threshold-crossing event; no message is lost (queued messages rescheduled).
- The kill switch stops sends within 5 s across all workers (cache invalidation via Valkey pub/sub; send processor re-checks).
- DNS checks never block on slow DNS (timeouts) and report `unknown` rather than `pass` on failure.
### Non-functional
- Checks are polite (cached; no more than daily per domain unless requested).
- Fix instructions are exact for Google Workspace and Microsoft 365 and generic for others.

## Design
```
apps/api/src/modules/outreach/
├── domain/deliverability/{rules.ts, health-metrics.ts, spf-evaluator.ts, dmarc-parser.ts, readiness.ts}
├── application/deliverability/{check-domain.ts, evaluate-health.ts, kill-switch.ts, digest.ts}
├── infrastructure/deliverability/{dns/{resolver.ts, doh.client.ts}, dnsbl/*.ts, processors/{dns-check.processor.ts,
│                                   health.processor.ts, digest.processor.ts}, presets/providers.yaml}
└── interface/http/{deliverability.controller.ts}
apps/web/src/features/outreach/deliverability/{dashboard.tsx, domain-card.tsx, mailbox-health.tsx,
                                                kill-switch.tsx, fix-instructions.tsx}
```
- Patterns:
  - Specification (rules).
  - Observer (event-driven health evaluation).
  - Circuit breaker semantics at the business level (pause and resume).
  - Feature-flagged adapters (DNSBL).

## Implementation plan
1. DNS evaluators (SPF recursive lookup counting, DKIM probing, DMARC parsing) with fixtures; provider presets.
2. Domain check service, caching, readiness gate integration with BF-050/BF-052.
3. Health metrics from events; rules engine; auto-pause with rescheduling; notifications.
4. Kill switch (flag, cache, banner, sequence pause).
5. Optional DNSBL adapters (behind a flag, terms documented).
6. Dashboard UI with fix instructions; weekly digest; metrics and alerts.

## Testing
- **Unit:**
  - SPF evaluation (includes, redirects, lookup count > 10, multiple records);
  - DMARC parsing;
  - DKIM key length parsing;
  - rules thresholds with minimum samples;
  - readiness decisions.
- **Integration:**
  - a mocked DNS resolver drives pass/warn/fail states and readiness blocks;
  - hard-bounce events cross the threshold → mailbox paused → queued messages rescheduled → owner notified;
  - kill switch stops an in-flight batch (no sends after the switch, verified with Mailpit counts).
- **E2E:** dashboard shows a failing DKIM with Google instructions; re-check after fixing the mocked DNS shows pass; kill switch banner appears and resume works.

## Acceptance criteria
- [ ] SPF/DKIM/DMARC/MX (+ informational MTA-STS/TLS-RPT/BIMI) checks with exact fix instructions and readiness gating.
- [ ] Rolling health metrics and data-driven auto-pause rules with safe rescheduling and notifications.
- [ ] Workspace kill switch effective within seconds; audited.
- [ ] Optional blocklist checks behind a flag with documented terms.
- [ ] Deliverability dashboard and weekly digest; metrics and alerts.

## Agent prompt
```text
Implement BF-056 (Deliverability guardrails).

Read first: AGENTS.md, docs/ARCHITECTURE.md §12 and §14, docs/DOMAIN.md §3.7, BF-050 (mailboxes, selector, ramp),
BF-052 (send processor, queued rescheduling), BF-054 (bounce/unsubscribe/negative signals), BF-055 (unsubscribe
events).

Rules:
- Fail safe: unknown DNS results are not passes; auto-pause on threshold with minimum samples; never lose messages.
- Kill switch must be effective across all workers within seconds.
- Fix instructions must be exact and localized (EN/FR) for Google Workspace and Microsoft 365.
- Verify DNSBL usage terms before enabling any list; keep them behind a flag.

Verify: pnpm verify && pnpm test:int && pnpm e2e (deliverability).
```

## References
- docs/ARCHITECTURE.md §12 · BF-050 · BF-052 · BF-054
- Google email sender guidelines: https://support.google.com/a/answer/81126 · Yahoo sender best practices: https://senders.yahooinc.com/best-practices/ · RFC 7208 (SPF): https://www.rfc-editor.org/rfc/rfc7208 · RFC 6376 (DKIM): https://www.rfc-editor.org/rfc/rfc6376 · RFC 7489 (DMARC): https://www.rfc-editor.org/rfc/rfc7489 · Google Postmaster Tools: https://postmaster.google.com/ · Spamhaus Data Query Service: https://www.spamhaus.com/data-access/free-data-query-service/
