---
id: BF-048
title: Preview claim, contact and opt-out capture — public leads API, anti-spam, CRM automation, leads inbox
milestone: M3 Build
epic: site-platform
type: feature
priority: P0
size: L
depends_on: [BF-012, BF-024, BF-035, BF-036]
blocks: [BF-055, BF-058, BF-060, BF-062]
areas: [api, sites, web]
---

# BF-048 — Preview claim, contact and opt-out capture: public leads API, anti-spam, CRM automation, leads inbox

## Context
The preview is proof, and the conversion moment is the prospect clicking **"This is my business — I'm interested"** on it ([PRD J6](../PRD.md#5-key-user-journeys), FR-47). The renderer already shows the banner with claim and opt-out entry points, a contact-form island and a signed site token (BF-036). This ticket builds:
- the public API behind them;
- privacy-friendly anti-spam with no third-party scripts;
- CRM automation (pipeline status, task, notification, attribution to the email that drove the visit);
- a respectful **opt-out** that stops contact and can take the preview down;
- a leads inbox in the dashboard.

Previews are concept sites the business has not approved. A contact form on a preview must not mislead visitors into thinking they are writing to the business. In preview mode, form submissions go to the **agency**, with a clear notice. Live sites (BF-062) route contact requests to the business.

## Goal
Public, rate-limited, signed endpoints for `claim_interest`, `contact_request` and `opt_out`. They are protected by honeypot, timing, proof-of-work and heuristics, store leads with consent records, and trigger CRM automation. A claim page and success flows are localized on the renderer, and a leads inbox and notifications are added to the dashboard.

## Scope
**In scope**
- **Data**: `site_leads`:
  - `id`, `organization_id`, `site_id`, `business_id`, `publication_id`;
  - `kind` (`claim_interest|contact_request|opt_out`), `source` (`banner|claim_page|contact_block|opt_out_link`);
  - `name?`, `email?` (citext), `phone?` (E.164), `whatsapp?`, `message?` (plain text ≤ 2000), `preferred_channel?`, `preferred_time?`, `locale`;
  - `consent` jsonb (`textVersion`, `checked`, `at`);
  - `attribution` jsonb (`campaignRef` from `?c=`, `outreachToken` id from `?r=` resolved to `outbound_message_id`/`sequence_enrollment_id` when BF-052/BF-053 exist, `siteVersionId`, `generationJobId`, `engine`);
  - `spam` jsonb (score, signals), `status` (`new|in_progress|qualified|discarded|spam`), `handled_by?`, timestamps.

  Indexes for the inbox (org, status, created_at). Retention: leads 24 months, spam 30 days (configuration; `system.retention`).
- **Public API** (no session; CORS restricted to `https://*.<SITES_BASE_DOMAIN>`; payload ≤ 16 KB):
  - `POST /v1/public/sites/leads`:
    - body: `{ siteToken, kind, fields…, consent, altcha, hp (honeypot), t (form render timestamp signed), submissionId }`;
    - steps:
      1. verify the token (HMAC, expiry, publication active or within a 7-day grace for `opt_out`);
      2. validate the fields per kind (claim requires at least one channel; opt-out requires nothing);
      3. run anti-spam;
      4. idempotency via `submissionId`;
      5. persist;
      6. emit an outbox event.
    - Response: localized success message key; never leaks whether the business exists elsewhere.
  - `GET /v1/public/sites/altcha-challenge?siteToken=`: issues a proof-of-work challenge. Use **ALTCHA** (open-source, self-hosted, no third-party requests; verify the current library and widget). Difficulty is adaptive to spam pressure.
- **Anti-spam** (Chain of Responsibility, each step adds signals):
  - honeypot field;
  - minimum fill time (≥ 3 s, from a signed render timestamp) and maximum age (24 h);
  - ALTCHA verification;
  - rate limits with a daily-salted IP hash (5/hour per IP per site, 50/day per site, global circuit);
  - content heuristics: URL count, disposable email domains, script/HTML injection patterns, language mismatch, repeated payloads.

  Score thresholds route the lead to `spam` (stored, no automation) or accept it. Raw IPs are never stored (same approach as the BF-035 views).
- **Renderer** (`apps/sites`, extending BF-036):
  - **Claim flow**: the banner button opens `/claim` (localized route, preview only), a short form with name, phone/WhatsApp, email, message, preferred channel/time and consent checkbox linking to `/privacy`. It shows agency identity and contact (from workspace settings) and an optional "Message us on WhatsApp" link to the agency (`wa.me` with prefilled text naming the business; the number comes from settings). The success page has next steps.
  - **Contact block in preview**: inline notice "Demo form — messages go to {agency}, not to {business}" (localized). Submissions use `kind = contact_request`. In `live` environment (BF-062), routing goes to the business (out of scope here).
  - **Opt-out flow**: the banner link "Not interested / don't contact me" opens `/opt-out`.
    - With a valid `?r=` outreach token, the confirmation is one click.
    - Without it, the page asks for an optional reason and contact for confirmation.
    - Options: "Stop contacting us" (always) and "Remove this preview" (checked by default).
    - The page explains what happens and links to the privacy page.
  - `/privacy` page per workspace (agency identity, purposes, legal basis summary, retention, rights and contact), localized, with versioned text; the consent text version is stored with each lead.
  - Forms work without JavaScript: progressive enhancement with server actions or plain POST + redirect. ALTCHA is enhanced with JS when available; without JS, stricter heuristics and a lower rate limit apply.
- **Automation** (subscribers to `site.lead.captured` / `site.opt_out.requested`, idempotent):
  - **Claim and contact**:
    1. OrgBusiness pipeline status → `engaged` (DOMAIN §3.1 allows it from `new`, `qualified` and `contacted`; from later stages only an activity is added, never a downgrade);
    2. activity timeline entry (BF-024);
    3. task "Call back {name} ({channel})" assigned to the business owner or site creator, due in 1 business day (workspace timezone);
    4. in-app + email notification to watchers (BF-012) with a deep link (no PII in email subjects);
    5. realtime update of the inbox.
    6. The `site.lead.captured` payload carries the attribution; BF-052/BF-053/BF-058 subscribe (stop sequences, mark conversion, analytics).
  - **Opt-out**:
    1. immediately set `do_not_contact = true` on the OrgBusiness, with reason and audit entry;
    2. emit `site.opt_out.requested` (BF-055 subscribes to create a formal suppression record and confirmation handling);
    3. if "remove preview" is chosen (or the workspace policy forces it), **unpublish** the preview via BF-035 within 5 minutes (renderer revalidation shows the "preview removed" 410 page);
    4. notify the owner.

    Opt-outs are honoured even if the token is expired (within the grace period) or anti-spam is uncertain (treated as low risk). Rate limits still apply.
- **Dashboard leads inbox** (`/leads`):
  - list (filters: status, kind, site, business, date, source, campaign), unread badge in navigation, realtime;
  - detail drawer: fields, consent, attribution (campaign, email, engine/version), spam signals (admins), timeline;
  - actions: change status, assign, add note, open business/site, quick-contact links (`tel:`, `wa.me`, `mailto:`; outreach composer when BF-051 lands).
  - CSV export (permission `leads:export`, audited).
  - Permissions: `leads:read`, `leads:manage`.
- **Contracts**: lead DTOs, public request schemas, event payloads (`site.lead.captured`, `site.opt_out.requested`) in `@bf/contracts`.

**Out of scope**
- Formal suppression lists and unsubscribe for email (→ BF-055), outreach attribution consumers (→ BF-052/BF-053), analytics dashboards (→ BF-058), live-site contact routing and custom domains (→ BF-062).

## Requirements
### Functional
- A claim from a preview creates exactly one lead (idempotent), moves the business to *Engaged*, creates a task and notifies within 5 s (P95).
- An opt-out sets do-not-contact immediately and unpublishes the preview when requested; it can never be blocked by anti-spam false positives.
- No third-party scripts or requests on the renderer; forms work without JavaScript.
### Non-functional
- Public endpoints are rate-limited, CORS-restricted and size-limited; no raw IPs stored; PII never logged (hashed emails in logs only).
- Lead endpoints P95 < 300 ms (excluding async automation).

## Design
```
apps/api/src/modules/sites/
├── domain/leads/{lead.ts, spam-policy.ts, lead-status.ts}
├── application/leads/{submit-lead.ts, change-lead-status.ts, list-leads.ts, export-leads.ts,
│                      subscribers/{on-lead-received.ts, on-opt-out.ts}}
├── infrastructure/leads/{altcha.service.ts, spam/{honeypot,timing,rate,content}.check.ts, repositories/*}
└── interface/http/{public-leads.controller.ts, leads.controller.ts}
apps/sites/src/app/{claim/page.tsx, opt-out/page.tsx, privacy/page.tsx}, components/{claim-form.tsx, …}
apps/web/src/features/leads/{leads-inbox.tsx, lead-drawer.tsx, nav-badge.tsx}
```
- Patterns:
  - Chain of Responsibility (anti-spam).
  - Domain events + Outbox subscribers (automation).
  - Progressive enhancement (forms).
  - Specification (spam policy thresholds).
  - Idempotency key (submission id).

## Implementation plan
1. Contracts + table + repositories; token verification shared with the renderer (`@bf/contracts` signing helpers).
2. Public endpoint with validation, idempotency and anti-spam chain (verify ALTCHA library usage).
3. Automation subscribers (pipeline, task, notification, unpublish, do-not-contact) with idempotency.
4. Renderer pages (claim, opt-out, privacy) and the contact-block notice; no-JS paths.
5. Leads inbox UI with realtime, filters, actions and export.
6. Retention and audit; E2E and abuse tests.

## Testing
- **Unit:** spam policy scoring per signal; token verification (expired, tampered, inactive publication, grace for opt-out); lead status transitions.
- **Integration:**
  - claim yields lead + pipeline `engaged` + task + notification + event (single, idempotent on retry);
  - opt-out with "remove preview" gives `do_not_contact` + unpublish + revalidation called;
  - spam submission is stored as spam with no automation;
  - rate limits enforced;
  - no raw IP in the database (assert columns and logs);
  - CORS rejects foreign origins.
- **E2E** (renderer + dashboard):
  - open the preview → click claim → submit (JS on and off) → lead appears in the inbox in real time;
  - opt-out via an `?r=` link → preview shows the 410 "removed" page.
- **Abuse:** scripted burst submissions are throttled; honeypot and too-fast submissions are flagged.

## Acceptance criteria
- [x] Public leads API (claim, contact, opt-out) with signed tokens, validation, idempotency, CORS and rate limits.
- [x] Privacy-friendly anti-spam (honeypot, timing, self-hosted proof-of-work, heuristics), no third-party scripts.
- [x] Renderer claim, opt-out and privacy pages (localized, no-JS capable); preview contact forms clearly routed to the agency.
- [x] Automation: pipeline status, task, notifications, conversion event with attribution; opt-out sets do-not-contact and can unpublish.
- [x] Leads inbox with realtime, filters, actions, export (audited); retention configured.

## Agent prompt
```text
Implement BF-048 (Preview claim, contact and opt-out capture).

Read first: AGENTS.md, docs/PRD.md (J6, FR-47), docs/compliance/outreach-compliance.md (opt-out expectations),
docs/conventions/security.md (§3 input handling, §7 privacy), docs/DOMAIN.md (§3.1 pipeline), BF-036 (banner, form
island, site token), BF-035 (unpublish, views privacy approach), BF-024 (pipeline/tasks/activity), BF-012 (events/
notifications). Skim BF-052, BF-053, BF-055 and BF-058 (they subscribe to your events).

Rules:
- Previews must not mislead: demo contact forms say clearly that messages go to the agency.
- Opt-outs are honoured immediately and are never blocked by anti-spam; offer to remove the preview.
- No third-party scripts or requests on rendered sites; forms work without JavaScript.
- Never store raw IPs; never log PII; consent text is versioned and stored with each lead.
- Automation is event-driven and idempotent.

Verify: pnpm verify && pnpm test:int && pnpm e2e (sites + leads); attach screenshots of the claim/opt-out pages (FR/EN)
and the inbox.
```

## References
- docs/PRD.md J6 · BF-035 · BF-036 · docs/compliance/outreach-compliance.md
- ALTCHA (self-hosted proof-of-work captcha): https://altcha.org/docs/ · OWASP Automated Threats (form abuse): https://owasp.org/www-project-automated-threats-to-web-applications/ · CNIL guidance on consent and contact forms: https://www.cnil.fr/fr/les-bases-legales/consentement
