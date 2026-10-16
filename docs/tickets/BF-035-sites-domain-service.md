---
id: BF-035
title: Sites domain service (sites, immutable versions, publications, assets, views, expiry)
milestone: M3 Build
epic: site-platform
type: feature
priority: P0
size: L
depends_on: [BF-006, BF-012, BF-014, BF-033]
blocks: [BF-036, BF-037, BF-038, BF-039, BF-047, BF-048, BF-051, BF-053, BF-062]
areas: [api, worker, db]
---

# BF-035 — Sites domain service (sites, immutable versions, publications, assets, views, expiry)

## Context
A **site** belongs to a workspace and previews a business; its content lives in immutable **site versions** (SiteSpec documents, BF-033); a **publication** points a hostname to a version with an environment (`preview`/`live`) and an expiry ([DOMAIN.md](../DOMAIN.md#34-site-publication)). The renderer (BF-036) reads published versions through a read-only DB role ([ADR-0004](../adr/0004-drizzle-orm-and-migration-ownership.md)). Generation jobs (BF-039), the editor (BF-037) and chat edit (BF-047) create versions through this module.

## Goal
A `sites` module that manages sites, versions (with validation, optimistic concurrency, diffs, rollback), publications (preview with expiry, unpublish, renderer revalidation), assets (upload, processing, licensing), view analytics, and exposes a read model for the renderer.

## Scope
**In scope**
- Tables:
  - `sites`: `id`, `organization_id`, `business_id`, `slug` (globally unique), `name`, `status` (`draft|preview|live|archived`), `default_locale`, `current_version_id`, `created_by`, timestamps.
  - `site_versions`: `id`, `site_id`, `version_number` (per site, sequential), `spec` jsonb, `spec_hash`, `schema_version`, `author_type` (`user|generation_job|chat_edit|import|rollback`), `author_id`, `parent_version_id`, `change_summary`, `validation` jsonb (issues summary), `quality` jsonb (filled by BF-045), `created_at`; **immutable** (trigger blocks UPDATE except `quality` set-once).
  - `site_publications`: `id`, `site_id`, `version_id`, `environment` (`preview|live`), `hostname`, `status` (`active|expired|unpublished`), `published_by`, `published_at`, `expires_at`, `ended_at`; partial unique: one active publication per (site, environment); unique active hostname.
  - `site_assets`: `id`, `organization_id`, `site_id?` (null = workspace library), `business_id?`, `storage_key`, `public_url`, `mime`, `width`, `height`, `bytes`, `sha256`, `variants` jsonb (sizes/formats), `license` (`owner_site|stock|ai_generated|uploaded`), `license_details` jsonb (`author`, `sourceUrl`, `attributionText`, `provider`), `alt` jsonb, `dominant_colors` jsonb, `focal_point` jsonb, `created_by`, `created_at`.
  - `site_view_daily`: `site_id`, `day`, `page_views`, `unique_estimate`, `by_locale` jsonb, `by_campaign` jsonb; PK (`site_id`, `day`).
- Read model for the renderer: SQL view `renderer_published_sites` (`hostname`, `site_id`, `organization_id`, `business_name`, `agency_name`, `agency_url`, `environment`, `version_id`, `spec`, `expires_at`, `noindex`) + grants to role `bf_sites_ro` (only this view and `site_assets` public fields).
- Domain: `Site` aggregate (status transitions; at most one active publication per environment; cannot publish an invalid version), `SlugService` (from business name + locality; transliteration incl. French accents; reserved words `www|app|api|admin|mail|docs|status|static|cdn|assets|preview`; max 40 chars; uniqueness with numeric suffix; profanity-safe), `VersionDiff` (structural diff: pages added/removed, blocks added/removed/moved/changed, text changes per locale with before/after excerpts).
- Commands (permissions: `sites:generate` to create/edit, `sites:publish` to publish):
  - `CreateSite(orgId, businessId, initialSpec?)` (idempotent per (org, business) unless `forceNew`).
  - `CreateSiteVersion(siteId, spec, author, baseVersionId)` → `migrateSpec` + `validateSite` (errors block; warnings stored) + optional facts validation (strict mode flag) + optimistic concurrency (`baseVersionId` must equal `current_version_id`; else `VERSION_CONFLICT` 409 with current id).
  - `ApplySpecOperations(siteId, ops[], baseVersionId, author)` using BF-033 ops (atomic) → new version with auto change summary.
  - `PublishPreview(siteId, versionId, { expiresInDays = 30 })`, `ExtendPreview(siteId, days)`, `Unpublish(siteId, environment)`, `Rollback(siteId, versionId)` (new version copying target spec, author `rollback`), `ArchiveSite`.
  - On publish/unpublish/expire: emit events, enqueue renderer revalidation (`POST <SITES_INTERNAL_URL>/api/revalidate` with HMAC, tags `site:<id>` and `host:<hostname>`), enqueue screenshot job (`sites.screenshot`: desktop/mobile thumbnails of home via the static renderer or by visiting the preview URL) stored as assets for UI cards.
- Expiry: repeatable `sites.expire` hourly → expire active previews past `expires_at` (status `expired`), event `site.expired`, optional notification; renderer shows the expired page (BF-036).
- Assets API: `POST /v1/sites/:id/assets/upload-url` (presigned PUT to `bf-sites` bucket; size/MIME constraints; license required in request), `POST /v1/sites/:id/assets/:assetId/finalize` (verify object exists, sniff MIME by magic bytes, compute sha256, dimensions; enqueue processing job: EXIF strip, resize variants 480/768/1200/1920, WebP+AVIF, dominant colors), `GET /v1/sites/:id/assets`, `DELETE` (only if unreferenced by any version).
- Views ingestion: `POST /v1/public/sites/views` (anonymous, rate-limited; body: signed site token from renderer, page id, locale, campaign ref `c`) → Valkey HyperLogLog per (site, day) for unique estimates using a daily-salted hash of IP+UA (raw values never stored) + counters; flushed to `site_view_daily` every 5 minutes; emits hourly aggregated `site.viewed` events (used by scoring engagement features and analytics).
- Queries/APIs: `GET /v1/sites` (filters: status, business, author type, created by engine; cursor), `GET /v1/sites/:id` (with current version summary, publications, latest quality, view counts), `GET /v1/sites/:id/versions` (cursor), `GET /v1/sites/:id/versions/:versionId` (full spec), `GET /v1/sites/:id/diff?from=&to=`, all commands above.

**Out of scope**
- Renderer app (→ BF-036), editor (→ BF-037), stock/AI/owner-site asset sourcing (→ BF-038), lead forms (→ BF-048), custom domains for live sites (→ BF-062).

## Requirements
### Functional
- Versions are immutable; rollback creates a new version; concurrent edits produce a conflict, not lost updates.
- Publishing an invalid version is impossible (409/422 with issues).
- Views never store raw IPs or user agents.
### Non-functional
- Publishing → renderer serves the new version within 5 s (revalidation).
- Asset processing < 10 s per image; originals retained privately, public variants served via CDN URLs.

## Design
```
modules/sites/
├── domain/{site.ts, slug.service.ts, version-diff.ts, publication-policy.ts}
├── application/{commands/*, queries/*, subscribers/*}
├── infrastructure/{repositories/*, processors/{expire,screenshot,asset-process,views-flush}.processor.ts,
│                   renderer-revalidator.ts, storage/presign.ts}
└── interface/http/{sites.controller.ts, versions.controller.ts, assets.controller.ts, public-views.controller.ts}
```
- Patterns: Aggregate + immutable versions (event-sourcing-lite without replay), Optimistic Concurrency, CQRS read model (renderer view), Outbox events.

## Implementation plan
1. Tables + immutability trigger + read-model view + grants (migration) + repositories.
2. Domain services (slug, diff, policies) with unit tests.
3. Commands/queries/APIs with integration tests (concurrency, invalid publish, rollback).
4. Revalidation client (HMAC) + screenshot job (static renderer from BF-034 + Playwright).
5. Assets upload/finalize/processing.
6. Views ingestion + flush + events.
7. Expiry job + events + notifications.

## Testing
- Unit: slug generation (accents, collisions, reserved), diff summaries, publication policy.
- Integration: version immutability (UPDATE rejected), optimistic concurrency conflict, publish invalid → rejected, rollback, expiry job, renderer view returns only active publications and is readable by `bf_sites_ro` but not writable, asset finalize with wrong MIME rejected, views counting + HLL estimates + no raw IP persisted.

## Acceptance criteria
- [x] Sites/versions/publications/assets/views tables with immutability and grants.
- [x] Commands for create/version/ops/publish/extend/unpublish/rollback/archive with permissions and events.
- [x] Renderer read model + HMAC revalidation + screenshot thumbnails.
- [x] Asset upload pipeline with licensing and processing.
- [x] Privacy-preserving view analytics and hourly `site.viewed` events.
- [x] Preview expiry job.

## Agent prompt
```text
Implement BF-035 (Sites domain service).

Read first: AGENTS.md, docs/adr/0004 and 0009, docs/DOMAIN.md (§2 Site invariants, §3.4 publication),
docs/ARCHITECTURE.md §10, docs/conventions/security.md (§3 uploads, §7 privacy).
Reuse: @bf/site-schema validation/ops/migrations (BF-033), static renderer (BF-034, for screenshots), outbox (BF-012),
business graph (BF-014).

Rules:
- Immutability and optimistic concurrency are enforced in the database, not only in code; test them.
- The renderer's DB access is read-only and limited to the view; prove a write fails with that role.
- Views analytics must never persist raw IPs/user agents (daily salted hashes, HyperLogLog).

Verify: pnpm verify && pnpm test:int.
```

## References
- ADR-0004 · ADR-0009 · docs/DOMAIN.md §3.4 · docs/ARCHITECTURE.md §10
- Valkey HyperLogLog: https://valkey.io/commands/pfadd/ · sharp: https://sharp.pixelplumbing.com/

## Implementation notes

**Part 1 (sites, versions, publications):**
- Migration 0026: `sites`, `site_versions`, `site_publications`, `site_assets`, `site_view_daily`. Versions are
  immutable in the database: a trigger refuses every UPDATE except setting `quality` (an object) once, and every
  DELETE except a site's cascade. One active publication per site and environment and per hostname (partial unique
  indexes). Foreign keys among versions and publications are `NO ACTION`, so deleting a site removes everything at once.
- Renderer read model, granted to `bf_sites_ro` (it reads nothing else and writes nothing, tested with read-write
  switched on): `renderer_published_sites` gives per hostname its latest publication with an effective status —
  `active`, `expired` (also once `expires_at` has passed, before the hourly job) or `unpublished` (also for an archived
  site) — with the spec only when active, so BF-036 can serve the page, a 410 page with the agency, or a 404; it carries
  `noindex` and `preview_banner` (forced on previews) and the agency URL only when it is http(s).
  `renderer_site_assets` gives the ready assets of sites with an active publication.
- Lookups: the renderer finds a host among all publications (an index on `site_publications.hostname`, not only the
  active one); `renderer_site_assets` checks the publication with `EXISTS` on the tables (not the whole view). Versions
  are deleted only once their site row is gone (a site or workspace cascade).
- Domain: slugs (name + locality, accents transliterated, long offensive stems dropped even inside words, short ones
  and phishing words as whole words only — Sussex, Pornic and computer stay —, then a random 6-character suffix
  redrawn when it spells a blocked word: preview addresses cannot be guessed or squatted and never reveal another
  workspace's site), the structural version diff (key-order insensitive; pages and blocks added/removed/moved/changed
  by id; text edits per locale, not counting texts of added or removed blocks), the publication policy.
- Commands (`sites:generate` to create and edit, `sites:publish` to publish, extend, unpublish and archive; writes
  throttled at 60/min): create (idempotent per business; a spec for a business that has a site is a 409
  `SITE_EXISTS`; at most 5 non-archived sites per business), versions from a spec or from BF-033 operations (atomic),
  rollback, preview publish/extend/unpublish, archive. Every edit locks the site row (`FOR NO KEY UPDATE`) and checks
  the base version; the database moves the current version only from that base (compare-and-set). Specs are upcast and
  validated (errors → 422 with each issue's path and code, warnings stored; at most 750 kB; at most 5,000 versions per
  site; the sites routes read JSON bodies up to the cap, other routes keep the 100 kB default); publishing
  re-validates the version. A compare-and-set that fails names the version that moved in its 409.
- Events: `site.created`, `site.version.created`, `site.published`, `site.preview.extended`, `site.unpublished`,
  `site.expired`, `site.archived`. The renderer is refreshed by an outbox subscriber of the publication events: a
  `sites-revalidate` job POSTs `{ tags: ["site:<id>", "host:<hostname>"] }` to `SITES_INTERNAL_URL/api/revalidate`,
  signed like internal calls (`SITES_REVALIDATE_SECRET`; skipped when unset, required in production; no redirect).
- Expiry: the worker enqueues `sites-expire` once per UTC hour; each due preview expires in its own transaction (a
  failing one is logged and skipped).
- Decisions: versions are validated in `published` mode (the same version may later go live); the renderer forces
  `noindex` and the banner on previews. Facts validation (strict mode) waits for the fact registry (BF-040). Preview URLs
  are `https://<slug>.<SITES_BASE_DOMAIN>/` (a lowercase hostname, validated).

**Part 2:**
- Images: `POST /v1/sites/:id/assets` declares type, size and license and returns a presigned PUT to the private
  assets bucket (`orgs/<org>/sites/<site>/assets/<id>/original`; type and length signed, 15 minutes);
  `POST …/assets/:assetId/finalize` sniffs the bytes, checks the size, decodes the dimensions (JPEG/PNG/WebP/AVIF only,
  ≤ 40 MP) and records their SHA-256; a `sites-asset-process` job re-checks that hash, then writes stripped WebP and
  AVIF variants (480/768/1200/1920 px reached by the image, and its own width below 1920; never enlarged) to the public
  sites bucket behind `SITES_ASSETS_BASE_URL`, with dominant colours. Status changes are compare-and-set (two
  finalizes, a late job and a delete never undo each other); the job's last failed attempt marks the image failed. An
  image is deleted only when no version names it (site row locked) and not while it is processed.
- Pictures: a `site.published` subscriber queues `sites-screenshot` (15 s later, after the renderer's refresh);
  services/intel photographs the home page (desktop, mobile) into the artifacts bucket under
  `orgs/<org>/sites/<site>/<publication>`; the keys are kept in `sites.thumbnails` only while that publication is
  active; members read them at `GET /v1/sites/:id/thumbnails/:kind` (nosniff, sandbox CSP). `FAKE_SITE_INTEL` draws
  placeholders.
- Views: `POST /v1/public/sites/views` (anonymous, always 204, 120/min per client IP) takes the page's signed site token
  (`SITES_VIEW_TOKEN_SECRET`, shared with the renderer). The visitor is a hash of their network address (IPv4, IPv6
  /64) with a random salt of the day kept in Valkey two days; one Lua script counts the view (at most 30 a day per
  visitor and site; at most 50 campaign references a day, the rest as `~other`) in day and hour counters and
  HyperLogLogs. Every 5 minutes the worker writes pending days to `site_view_daily` (totals only grow; a pair leaves the
  pending set only if no view arrived meanwhile) and emits one `site.viewed` per site and completed hour (2 minutes of
  grace; claimed in `site_view_hours`, so never twice). No IP, user agent or hash is stored in the database or events.
- The site detail carries `thumbnails` and 7/30-day `views` (unique visitors summed over days).
- Decisions: the upload route is `POST /assets` (not `/assets/upload-url`); originals stay in the private assets bucket
  and only re-encoded variants are public; pictures are a `sites.thumbnails` column, not `site_assets` rows (they are
  not site content); public variant keys are `sites/<site>/<asset>/…` (no workspace id in public URLs); local previews
  get no real pictures (intel's SSRF guard refuses `*.localhost`); the anonymous throttle now keys on the proxy-aware
  client IP (it keyed on the proxy's). Follow-ups: a bucket lifecycle rule for originals never finalized; a per-site
  image quota.

