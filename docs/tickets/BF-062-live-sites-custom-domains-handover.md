---
id: BF-062
title: Live sites — go-live wizard, custom domains with on-demand TLS, legal pages, client handover, static export, SaaS readiness
milestone: M5 Learn & Scale
epic: site-platform
type: feature
priority: P1
size: L
depends_on: [BF-024, BF-025, BF-035, BF-036, BF-038, BF-048]
blocks: []
areas: [api, sites, web, infra]
---

# BF-062 — Live sites: go-live wizard, custom domains with on-demand TLS, legal pages, client handover, static export, SaaS readiness

## Context
When a prospect says yes, the preview should become their real website with as little friction as possible. That is the agency's product. A **live** site differs from a preview ([DOMAIN §3.4](../DOMAIN.md#34-site-publication): `preview → live : claimed + domain attached`):
- no banner, indexable, sitemap;
- contact forms delivered to the business;
- the business's own domain with TLS;
- legal pages required by law (in France, *mentions légales* identify the site publisher and host; a privacy notice covers form data);
- assets whose ownership or licence is confirmed (unconfirmed owner-site images are `preview_only`, BF-038).

The agency also needs a clean handover: the client can see their site's stats and leads and request changes, and can take a static export if they leave.

The PRD keeps public SaaS signup and billing out of v1 but asks the architecture to keep the door open. This ticket documents what that would take.

## Goal
A go-live wizard that:
- validates readiness (assets, legal info, contact routing, content);
- attaches a custom domain with DNS verification and automatic TLS (Caddy on-demand TLS with an `ask` endpoint);
- publishes the live environment with SEO enabled;
- generates legal pages from structured data;
- routes forms to the business;
- invites the client to a lightweight portal (stats, leads, change requests);
- offers a static export.

A SaaS-readiness assessment completes the ticket.

## Scope
**In scope**
- **Tables**:
  - `site_domains`:
    - `id`, `organization_id`, `site_id`, `hostname` (citext, unique), `kind` (`apex|subdomain|www`), `redirect_to?` (e.g. `www` → apex), `verification_token`;
    - `status` (`pending_dns|verifying|verified|active|failed|removed`), `dns_report` jsonb, `tls_status`, `last_checked_at`, `created_by`, timestamps.
  - `site_legal_profiles`:
    - `site_id`, `business_legal_name`, `legal_form`, `registration` (SIRET/RCS or equivalent, optional per jurisdiction), `vat_number?`, `address`, `phone`, `email`;
    - `publication_director`, `host_info` (agency/hosting provider identity from workspace settings), `dpo_contact?`, `locales`;
    - `version`, `updated_by`.
  - `site_contact_routing`: `site_id`, `recipient_email` (verified via a confirmation link), `cc?`, `verified_at`.
- **Go-live readiness checks** (`GoLiveReadiness.evaluate(siteId)`, each check pass/warn/fail with a fix link):
  - Pipeline stage `proposal` or `won`, or an explicit override with a reason (go-live without a deal requires `sites:publish` + `settings:manage`).
  - All assets licensed for live use: no `preview_only`; owner-site images confirmed via the BF-038 confirm-ownership endpoint, or replaced; stock attributions present.
  - Legal profile complete for the business's jurisdiction (FR/BL/MF: *mentions légales* fields; others: imprint where required, otherwise contact identity).
  - Privacy notice generated and acknowledged.
  - Contact routing email verified.
  - Content: validation errors = 0, quality gates passed or accepted (BF-045), facts confirmed by the client (checkbox with name and date: the client reviewed the content).
  - SEO basics: titles and descriptions per locale, OG image, favicon.
- **Live publication**:
  - BF-035 `PublishLive(siteId, versionId)` (new command): environment `live`, no expiry, `noindex = false`.
  - The renderer drops the preview banner and claim/opt-out links, serves `robots.txt` allowing crawling + `sitemap.xml`, sets `hreflang`, adds `LocalBusiness` JSON-LD generated **from facts** (name, address, phone, hours, geo, sameAs), and canonical URLs on the custom domain.
  - The preview hostname 301-redirects to the live domain once the domain is active (configurable).
  - Contact forms in live mode deliver to `site_contact_routing` by email (sent via a transactional sender: agency SMTP or a transactional provider, configured separately from the outreach mailboxes) and store leads as before (BF-048), now `source = live_site`.
- **Custom domains**:
  - **Wizard**: enter the domain → choose apex + `www` behaviour → instructions per DNS provider (generic + presets for common registrars):
    - subdomain/`www`: CNAME to `cname.<SITES_BASE_DOMAIN>`;
    - apex: A/AAAA to our ingress IPs, or ALIAS/ANAME/CNAME-flattening when supported;
    - TXT `_bf-verify.<domain>` = token.
  - **Verification job**: polls DNS (exponential backoff for up to 72 h, plus a manual "check now"); verifies the TXT token and the routing records; reports a DNS diff ("expected CNAME … found A …"); then `verified`.
  - **TLS via Caddy on-demand TLS**:
    - the Caddyfile gets an `on_demand_tls { ask <internal-url>/internal/domains/allow }` block (verify the current Caddy syntax);
    - the internal endpoint (only reachable from Caddy; shared-secret header or network restriction) returns 200 **only** for hostnames in `site_domains` with status `verified|active`. This prevents certificate-issuance abuse;
    - rate limits; issuance monitored (cert expiry alerts in BF-061).
  - Renderer tenant resolution (BF-036) extended: custom hostname → site (cached; revalidated on domain changes).
  - Removing a domain: status `removed`, renderer stops serving it, certificate left to expire.
  - Documented alternative: if `apps/sites` is deployed on Vercel, the Vercel Domains API replaces on-demand TLS (adapter interface `DomainProvider` with a `caddy` implementation now).
- **Legal pages** (generated, localized FR/EN, as rendered system pages, not free-form blocks):
  - `/mentions-legales` (FR) / `/legal-notice` (EN): publisher identity (business), publication director, host (agency/hosting provider: name, address, phone, from workspace settings), intellectual property and credits (stock attributions), contact.
  - `/confidentialite` / `/privacy`:
    - controller: the business;
    - processor: the agency (hosting and forms);
    - purposes (contact requests), legal basis, retention (configurable), rights and how to exercise them, cookieless analytics statement.
  - Templates are versioned and flagged `needs_legal_review` (not legal advice); the agency confirms them once in settings.
  - Footer links added automatically on live sites.
  - **Processor agreement (DPA) template** (Markdown/PDF export) for the agency to sign with the client, documented in `docs/compliance/dpa-template.md`.
- **Client handover portal (lite)**:
  - Invite the business owner by email (Better Auth magic link) as a **`client` role scoped to specific site ids** (new permission scope; verify Better Auth organization/role customization).
  - Portal pages:
    - site overview (live URL, status);
    - analytics (views by page and locale, leads count; cookieless data from BF-035);
    - leads list (their own site's submissions);
    - **change requests** (form → task for the agency, with screenshot attachment upload to private storage);
    - content approval for proposed versions (approve or request changes on a version preview link).
  - Strict isolation: client users see nothing else (tests reuse the BF-060 cross-tenant harness).
- **Static export**: `POST /v1/sites/:id/export` → job renders all pages × locales with the BF-034 static renderer and packages HTML, CSS, fonts and assets (self-hosted copies where licences allow; hotlinked stock stays hotlinked with attribution) plus a README into a zip. A signed download link is valid for 24 h. Export is available to the agency (and to the client portal if enabled).
- **SaaS readiness assessment** `docs/product/saas-readiness.md`:
  - what public self-serve signup would require: signup abuse controls, outreach abuse prevention (sending only from verified domains with stricter defaults, mandatory legal review per jurisdiction per tenant), plan limits and quotas service, billing integration point (e.g. Stripe), tenant-level sending domains, support tooling, terms of service and acceptable-use policy;
  - current gaps and an estimate;
  - architectural hooks already present (workspaces, budgets, RBAC, RLS).
  - Ensure signup remains invite-only (`FEATURE_SELF_SERVE_SIGNUP=false` enforced in auth; test).

**Out of scope**
- Domain purchase/registration, email hosting for clients, e-commerce, client billing and invoicing, a full CMS for clients (Payload/Directus remain options for later per ADR-0009).

## Requirements
### Functional
- On-demand TLS issues certificates **only** for verified hostnames (test: the `ask` endpoint returns 403 for unknown or unverified domains; Caddy config test).
- A live site cannot be published with `preview_only` assets, an incomplete legal profile or an unverified contact routing email.
- The live renderer has no preview banner, allows indexing, and serves legal pages and JSON-LD built from facts only.
- Client users can only access their own sites' data.
### Non-functional
- Custom domain from verified DNS to a valid certificate in < 2 minutes (P95).
- The static export of a 6-page FR/EN site completes in < 60 s.

## Design
```
apps/api/src/modules/sites/
├── domain/{go-live-readiness.ts, domain-verification.ts, legal-profile.ts, client-access.ts}
├── application/{publish-live.ts, domains/{add.ts, verify.ts, remove.ts}, legal/*.ts, contact-routing/*.ts,
│                export/static-export.ts, client-portal/*.ts}
├── infrastructure/{dns/verifier.ts, domain-providers/{caddy.provider.ts}, processors/{domain-verify.processor.ts,
│                   export.processor.ts}, mail/transactional-sender.ts}
└── interface/http/{go-live.controller.ts, domains.controller.ts, internal-domains-allow.controller.ts,
                    client-portal.controller.ts, export.controller.ts}
apps/sites/src/{lib/tenant.ts (custom domains), app/(system)/{mentions-legales,legal-notice,privacy,confidentialite}/*,
                lib/jsonld.ts, app/sitemap.xml/route.ts (live)}
apps/web/src/features/sites/go-live/{wizard.tsx, readiness-checklist.tsx, domain-step.tsx, legal-step.tsx,
                                      routing-step.tsx}
apps/web/src/app/(client)/portal/* (client portal)
infra/caddy/Caddyfile (on_demand_tls ask)
docs/product/saas-readiness.md · docs/compliance/dpa-template.md
```
- Patterns:
  - Specification (readiness checks).
  - State Machine (domain verification).
  - Adapter (`DomainProvider`: Caddy now, Vercel later).
  - Template (legal pages).
  - Scoped RBAC (client role per site).

## Implementation plan
1. Readiness checks + `PublishLive` command + renderer live mode (no banner, SEO, JSON-LD, sitemap, legal routes).
2. Legal profile + legal page templates (FR/EN) + DPA template + settings confirmation.
3. Contact routing (verification email) + live form delivery via the transactional sender.
4. Custom domains: wizard, DNS verification job, `ask` endpoint, Caddy on-demand TLS config, tenant resolution, redirects.
5. Client portal (magic link, scoped role, pages) with isolation tests.
6. Static export job.
7. SaaS readiness document; enforce the invite-only signup flag.

## Testing
- **Unit:** readiness rules matrix, DNS verification outcomes (CNAME/A/ALIAS/TXT combinations), JSON-LD from facts, legal page rendering per jurisdiction.
- **Integration:**
  - `ask` endpoint allow/deny;
  - domain lifecycle with a mocked DNS;
  - go-live blocked by a `preview_only` asset, then allowed after ownership confirmation;
  - live form delivers to the verified email (Mailpit);
  - preview hostname redirects to the live domain;
  - client user isolation (cross-tenant harness);
  - static export contents (all pages and locales, assets, README).
- **E2E:** go-live wizard end to end on a fixture site with a local Caddy (`tls internal` + a test domain via `/etc/hosts` mapping in CI); client portal login via magic link (Mailpit) → sees stats and leads → submits a change request → the agency sees a task.

## Acceptance criteria
- [ ] Go-live wizard with readiness checks and `PublishLive`; renderer live mode with SEO, JSON-LD and legal pages.
- [ ] Custom domains with DNS verification and Caddy on-demand TLS restricted by the `ask` endpoint; redirects.
- [ ] Live contact routing to a verified business email; leads stored.
- [ ] Client portal (scoped client role): stats, leads, change requests, approvals; isolation proven.
- [ ] Static export zip.
- [ ] SaaS readiness document; invite-only signup enforced.

## Agent prompt
```text
Implement BF-062 (Live sites, custom domains and handover).

Read first: AGENTS.md, docs/adr/0009 and 0014, docs/DOMAIN.md §3.4, docs/ARCHITECTURE.md §10, BF-035 (publications),
BF-036 (renderer), BF-038 (asset restrictions, ownership confirmation), BF-048 (forms/leads), BF-025 (Caddy), BF-060
(cross-tenant harness, security gates). Verify current Caddy on-demand TLS syntax and Better Auth magic-link and
role-scoping APIs before coding.

Rules:
- Certificates only for verified domains (ask endpoint, deny by default).
- Go-live is blocked until assets, legal info and contact routing are compliant; legal templates are flagged for
  review (not legal advice).
- Live sites keep the cookieless, no-third-party-script policy.
- Client users are strictly scoped to their own sites.

Verify: pnpm verify && pnpm test:int && pnpm e2e (go-live + client portal).
```

## References
- docs/DOMAIN.md §3.4 · ADR-0009 · ADR-0014 · BF-035 · BF-036 · BF-038
- Caddy on-demand TLS: https://caddyserver.com/docs/automatic-https#on-demand-tls · LCEN art. 6 (mentions légales) overview (Service-public.fr): https://entreprendre.service-public.fr/vosdroits/F31228 · schema.org LocalBusiness: https://schema.org/LocalBusiness · Vercel Domains API (alternative): https://vercel.com/docs/domains
