---
id: BF-036
title: Sites renderer app — multi-tenant hosting of previews on our domain (apps/sites)
milestone: M3 Build
epic: site-platform
type: feature
priority: P0
size: L
depends_on: [BF-034, BF-035]
blocks: [BF-048, BF-060, BF-062]
areas: [sites, infra]
---

# BF-036 — Sites renderer app — multi-tenant hosting of previews on our domain (apps/sites)

## Context
Generated sites must be shareable instantly in an email or on a call at `https://<slug>.<sites-domain>`, without a build or deploy per site ([ADR-0009](../adr/0009-schema-driven-website-builder.md)). `apps/sites` resolves the hostname to the active publication via the read-only renderer view (BF-035), renders the version with `@bf/site-blocks` (BF-034), caches aggressively, revalidates on publish, and wraps previews with a banner, `noindex`, and claim/opt-out entry points. Caddy already routes the wildcard host (BF-025).

## Goal
A fast, secure, multi-tenant Next.js renderer that serves every published preview (and later live sites) with locale routing, SEO/robots rules per environment, preview banner, cookieless view beacon, tag-based revalidation and friendly expired/unknown pages.

## Scope
**In scope**
- `apps/sites` (Next.js App Router):
  - Middleware: parse `Host`; strip port; map to tenant key; reject non-matching hosts (404); add security headers (CSP with nonce, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`), `X-Robots-Tag: noindex, nofollow` for previews.
  - Tenant resolution: `getPublishedSite(hostname)` querying the `renderer_published_sites` view with the read-only role (`@bf/db` read-only client), cached with `'use cache'`/data cache tags `host:<hostname>` and `site:<id>` (verify current Next.js caching APIs) + short in-memory LRU.
  - Routes: `/[[...path]]` — default locale at root (`/`, `/about`), other locales prefixed (`/en/about`); `hreflang` alternates; canonical URLs; per-site `robots.txt` (previews: `Disallow: /`), `sitemap.xml` (live only); favicon from logo asset (generated variants) or neutral default.
  - Rendering with `SiteRenderer` (BF-034) using Next `Image` (remotePatterns restricted to our CDN/storage host) and Next `Link`.
  - Preview banner (renderer-level, not part of the spec; localized FR/EN/…): "Concept preview created by {agency} for {business}. Not affiliated." + buttons **"This is my business — I'm interested"** (opens claim form → BF-048) and **"Not interested / don't contact me"** (opens opt-out flow: if URL contains a signed outreach token `?r=…` (from emails, BF-052) → one-click suppression via public unsubscribe endpoint (BF-055); otherwise a short form). Dismissible per session; accessible; doesn't cover content (pushes layout).
  - Contact form island posts to the public leads endpoint (BF-048) with a signed site token embedded at render time (HMAC of site id + publication id + expiry).
  - View beacon: on page load, `navigator.sendBeacon` to `POST /v1/public/sites/views` (BF-035) with signed token, page id, locale, campaign ref from `?c=`; no cookies, no localStorage, respects `DNT`/GPC by not sending.
  - Revalidation endpoint `POST /api/revalidate` (HMAC-verified, replay-protected) → `revalidateTag` for given tags.
  - Error pages: unknown host/page → localized 404 with agency link; expired/unpublished → HTTP 410 page ("This preview has expired") with agency contact; renderer errors → 500 page without internals.
  - Dev-only `/__blocks` gallery (from BF-034) disabled in production.
- Dockerfile (standalone output) + compose services (local `apps` profile and prod compose from BF-025: replace the 503 placeholder upstream).
- Local wildcard development: document `*.sites.localhost` (works in most browsers) or `lvh.me` alternative; seed command publishes the four fixture sites for local testing.
- Lighthouse CI against locally running renderer for fixture previews (performance ≥ 95 mobile, accessibility ≥ 95, best practices ≥ 95); load test (autocannon) on a cached page: p95 < 50 ms at 200 rps on a dev machine.

**Out of scope**
- Lead capture backend and claim form content (→ BF-048), unsubscribe backend (→ BF-055), custom domains (→ BF-062).

## Requirements
### Functional
- Publishing/unpublishing a version updates the served page within 5 s (revalidation).
- Previews are never indexable (headers + robots.txt + meta).
- Locale switching links preserve the current page.
### Non-functional
- No third-party scripts/fonts/trackers on rendered sites.
- Read-only DB role; renderer has no write credentials of any kind.

## Design
```
apps/sites/src/
├── middleware.ts
├── app/[[...path]]/page.tsx
├── app/api/revalidate/route.ts
├── app/robots.txt/route.ts, app/sitemap.xml/route.ts
├── lib/{tenant.ts, cache-tags.ts, signing.ts, locale-routing.ts, csp.ts}
└── components/{preview-banner.tsx, beacon.tsx, expired-page.tsx, not-found-page.tsx}
```
- Patterns: Multi-tenant resolver, Cache-aside with tag invalidation, Decorator (banner wrapping rendered site).

## Implementation plan
1. Verify current Next.js multi-tenant middleware patterns, caching/revalidation APIs and standalone Docker output.
2. Tenant resolution + caching + locale routing + rendering of fixture sites.
3. SEO/robots/sitemap rules per environment; headers/CSP.
4. Banner, beacon, form island wiring (backend endpoints may be mocked until BF-048/BF-055 land; feature-flag their buttons).
5. Revalidation endpoint + integration with BF-035 publish flow.
6. Error pages; Docker/compose; local wildcard docs; Lighthouse + load tests.

## Testing
- Unit: locale routing, host parsing, signing/verification, CSP builder.
- Integration/E2E (Playwright): fixture site renders at `salon-gustavia.sites.localhost`; `/en/about` English page; robots/noindex headers on previews; publish new version → page updates after revalidation; expired publication → 410 page; unknown host → 404; beacon request sent without cookies; axe on rendered pages.
- Lighthouse CI and autocannon reports attached.

## Acceptance criteria
- [ ] Hostname → active publication → rendered site with locale routing and correct SEO rules.
- [ ] Previews: banner, noindex everywhere, claim/opt-out entry points, cookieless beacon.
- [ ] Tag revalidation on publish/unpublish/expire within 5 s.
- [ ] Friendly 404/410 pages; strict CSP and headers.
- [ ] Performance, a11y and load targets met (reports attached).

## Agent prompt
```text
Implement BF-036 (Sites renderer app).

Read first: AGENTS.md, docs/adr/0009 and 0014, docs/ARCHITECTURE.md §10 and §13, docs/conventions/security.md §8,
docs/compliance/outreach-compliance.md (opt-out expectations). Reuse: @bf/site-blocks (BF-034), renderer view +
revalidation HMAC + views endpoint (BF-035), Caddy wildcard routing (BF-025).

Rules:
- Verify current Next.js APIs for middleware, caching ('use cache'/tags) and revalidation before coding.
- The renderer is public-facing and read-only: no write credentials, strict CSP, no third-party scripts.
- Previews must be unindexable by three independent mechanisms (header, robots.txt, meta).

Verify: pnpm verify && pnpm e2e (sites suite); Lighthouse CI + load test reports in the PR.
```

## References
- ADR-0009 · ADR-0014 · docs/ARCHITECTURE.md §10
- Next.js multi-tenant guide: https://nextjs.org/docs/app/guides/multi-tenant · Next.js caching: https://nextjs.org/docs/app/deep-dive/caching · Vercel Platforms starter (reference): https://github.com/vercel/platforms

## Notes from BF-035

- Read `renderer_published_sites` by hostname: one row per hostname with an effective `status`. Serve the page only
  when `status = 'active'` (the `spec` is null otherwise); `expired`/`unpublished` rows are the 410 page (business and
  agency names, `agency_url` already restricted to http(s) — still escape it). No row is a 404.
- Images come from `renderer_site_assets` (ready assets of sites with an active, unexpired publication).
- Preview hostnames are `<slug>.<SITES_BASE_DOMAIN>` with a random 6-character suffix
  (`salon-lumiere-gustavia-k3x9p2.sites.localhost`): seed slugs accordingly; nothing guessable.
- Cache: a preview turns `expired` in the view as soon as `expires_at` passes, but the `site.expired` revalidation comes
  with the hourly job: cap a page's cache lifetime at `expires_at`.
- Pass `preview: true` to the site-blocks renderer for preview publications (banner, `noindex`, contact form off) and
  send `X-Robots-Tag: noindex`. Let services/intel's user agent read previews (published-site pictures, BF-035 part 2).

