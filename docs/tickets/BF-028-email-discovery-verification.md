---
id: BF-028
title: Email discovery, classification and verification
milestone: M2 Understand
epic: enrichment
type: feature
priority: P0
size: M
depends_on: [BF-027]
blocks: [BF-031, BF-049]
areas: [api, worker]
---

# BF-028 — Email discovery, classification and verification

## Context
Outreach quality and sender reputation depend on mailing only addresses that exist ([deliverability notes in ARCHITECTURE.md §12](../ARCHITECTURE.md#12-outreach-architecture)), and compliance depends on knowing whether an address is **generic** (info@) or **personal**, and **where it was published** (e.g. on the business's own contact page — relevant to the Netherlands' "published for that purpose" exception, see [outreach-compliance.md](../compliance/outreach-compliance.md)). Emails arrive from site intel (BF-026/BF-027), open data (Overture emails) and manual entry. Self-hosted Reacher (`check-if-email-exists`) verifies via SMTP and needs outbound port 25, which some VPS providers block ([ADR-0014](../adr/0014-hosting-vps-compose-caddy.md)).

## Goal
Every email contact is classified (generic/personal/department, free-mail, disposable, role) with publication context, and verified through a pluggable verifier chain with caching and per-domain politeness; statuses feed scoring and compliance.

## Scope
**In scope**
- Schema: add to `business_contacts`: `verification_details` jsonb (`reachable`, `isCatchAll`, `isDisposable`, `isRoleAccount`, `mxAcceptsMail`, `smtpCanConnect`, `provider`, `checkedVia`), `published_context` jsonb (`pageUrl`, `pageKind` (contact|home|footer|legal|other), `foundAs` (mailto|text|jsonld)), `is_free_mail` bool.
- Classification (domain service): subtype via `EmailAddress` VO (BF-014) + department dictionary (EN/FR: sales/ventes, booking/reservation(s), contact, info, hello/bonjour, admin, office/bureau, support, compta/accounting), free-mail list (gmail, hotmail, outlook, yahoo, icloud, orange.fr, wanadoo.fr, laposte.net, etc. — data file), disposable list (maintained package or data file with update script), relation to business domain (`matchesWebsiteDomain`).
- Optional pattern guessing (feature flag `emailPatternGuessing`, default **off**; jurisdictions allowing personal addresses only): if a person name is known (JSON-LD/about page) generate candidates (`first@`, `first.last@`, `f.last@`) → verify; never auto-used for outreach unless verified `valid` and compliance allows personal addresses.
- `EmailVerifier` port + adapters, chain configured per workspace:
  - `ReacherVerifier` (self-hosted backend from compose profile `verify`; verify current API path and response schema) → map `is_reachable` (`safe|risky|invalid|unknown`), catch-all, disposable, role, MX.
  - `CommercialVerifier` adapter skeleton (one implementation, e.g. ZeroBounce or NeverBounce — choose by current docs/pricing; API key from secrets vault) for hosts where port 25 is blocked.
  - `DnsMxVerifier` fallback (syntax + MX/A lookup) → `unknown` with `mxAcceptsMail` info.
- Politeness: per-recipient-domain rate limits (Valkey token buckets), greylisting retry with backoff, global concurrency cap; never verify the same address more than once per TTL (60 days) — cache by normalized email.
- Status mapping to `verification_status`: `valid` (safe), `risky` (catch-all/role uncertainty), `invalid`, `catch_all`, `disposable`, `unknown`.
- `email_verify` enrichment step (registered in BF-027 registry; depends on `site_intel`): classifies + verifies all unverified/stale email contacts of the business; cost tracking for commercial verifier.
- On-demand: `POST /v1/contacts/:id/verify` (`business:write`), bulk via enrichment bulk endpoint.
- Settings → Integrations: verifier chain order, Reacher URL, commercial key, "port 25 reachable?" diagnostic (`POST /v1/workspace/diagnostics/smtp-port` tries a TCP connect to a known MX on port 25 with timeout and reports).
- UI: contacts tab shows subtype badges (generic/personal/department), free-mail and disposable flags, verification status with details tooltip, publication context ("found on contact page"), verify button.

**Out of scope**
- Compliance decisions based on these fields (→ BF-049). Sending (→ M4).

## Requirements
### Functional
- Classification correct for FR/EN role addresses and free-mail domains (tests).
- Verification never runs against the same domain faster than the configured rate.
### Non-functional
- Verifier errors are retried only when transient; permanent `invalid` cached.
- No verification of addresses on suppression lists (check before calling verifiers) — suppression lookup port with a no-op default until BF-049.

## Design
- Patterns: Chain of Responsibility (verifier chain), Adapter (verifiers), Strategy (classification dictionaries per locale), Decorator (rate limit + cache around verifiers).

## Implementation plan
1. Classification dictionaries + domain service (unit tests).
2. Schema migration + repository updates.
3. Verifier port + Reacher/commercial/DNS adapters (MSW fixtures) + chain + politeness decorators.
4. Enrichment step registration + on-demand endpoint.
5. Settings + diagnostics endpoint; contacts tab UI.

## Testing
- Unit: classification tables (FR/EN roles, free-mail, disposable), status mapping from verifier responses, chain fallback behaviour.
- Integration: step updates contacts and records cost; caching prevents re-verification; per-domain rate limiting under burst (fake clock); suppression pre-check hook.
- Contract: recorded Reacher responses (safe, invalid, catch-all, timeout).

## Acceptance criteria
- [ ] Email contacts classified with subtype, free-mail, disposable, publication context.
- [ ] Verifier chain (Reacher → commercial → DNS) with caching and per-domain politeness.
- [ ] `email_verify` step registered; on-demand and bulk verification work.
- [ ] SMTP port diagnostic available; contacts UI shows statuses.

## Agent prompt
```text
Implement BF-028 (Email discovery, classification and verification).

Read first: AGENTS.md, docs/compliance/outreach-compliance.md, docs/ARCHITECTURE.md §12, docs/adr/0014 (port 25 note).
Reuse: enrichment framework + IntelClient (BF-027), contacts schema & EmailAddress VO (BF-014), secrets (BF-011).

Rules:
- Verify the current Reacher backend API and your chosen commercial verifier's API before coding.
- Pattern guessing stays behind a default-off flag and is never used for outreach unless verified and allowed.
- Be polite to mail servers: per-domain rate limits and caching are mandatory, with tests.

Verify: pnpm verify && pnpm test:int; demonstrate (locally) a Reacher check against your own test address if
port 25 is available, else document the DNS fallback.
```

## References
- docs/compliance/outreach-compliance.md · ADR-0014
- Reacher: https://github.com/reacherhq/check-if-email-exists · RFC 5321 (SMTP)
