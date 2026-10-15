---
id: BF-014
title: Business graph data model, value objects and repositories
milestone: M1 Find & List
epic: business-graph
type: feature
priority: P0
size: L
depends_on: [BF-003, BF-004, BF-006]
blocks: [BF-015, BF-016, BF-017, BF-022, BF-027, BF-035]
areas: [api, db]
---

# BF-014 — Business graph data model, value objects and repositories

## Context
Facts about businesses are **global** (shared by all workspaces); what a workspace does with a business is **org-scoped** ([ADR-0008](../adr/0008-global-business-graph-and-org-scoped-crm.md)). Every field of a golden record carries provenance ([ARCHITECTURE.md §6.2](../ARCHITECTURE.md#62-conventions)). This ticket creates the core tables, the `Business` aggregate and value objects, repositories, and the minimal org link (`org_businesses`) that search and discovery need before the full CRM (BF-024). Entity resolution (BF-016) and taxonomy data (BF-015) build on it.

## Goal
A well-indexed, provenance-aware schema for businesses, their sources, contacts, categories links, hours, media and reviews; a framework-free domain model with value objects that normalize phones, URLs, emails and addresses; repositories and a detail query; and `GET /v1/businesses/:id` returning global facts plus the workspace's state.

## Scope
**In scope**
- Schema files `packages/db/src/schema/business-graph.ts` and `crm.ts` (minimal), migrations:
  - `businesses`: `id`, `display_name`, `normalized_name` (lowercase, unaccented, legal suffixes stripped), `primary_category_id` (FK added in BF-015 migration if `categories` doesn't exist yet — create `categories` table skeleton here: `id`, `slug`, `parent_id`, `path` ltree, `labels` jsonb, `is_active`), `operating_status` (`operational|closed_temporarily|closed_permanently|unknown`), `website_url`, `website_host`, `website_registrable_domain`, `primary_phone_e164`, `country_code`, `locale_hint`, `location` geography(Point), `address` jsonb (components), `formatted_address`, `locality`, `postal_code`, `price_level` smallint, `rating_avg` numeric(2,1), `rating_count` int, `attributes` jsonb (provenance map), `data_quality` smallint, `merged_into_id` (self FK), `version` int (optimistic concurrency), `first_seen_at`, `last_seen_at`, timestamps.
  - `business_sources`: `id`, `business_id`, `provider`, `provider_ref`, `payload` jsonb, `normalized` jsonb, `content_hash`, `fetched_at`, `expires_at`, `match_confidence`, `linked_by` (`auto|manual`), timestamps; unique (`provider`, `provider_ref`).
  - `business_contacts`: `id`, `business_id`, `type` (`email|phone|whatsapp|website_form|social`), `value`, `normalized_value` (citext for email), `subtype` (`generic|personal|department|unknown` for email; `mobile|landline|unknown` for phone; network name for social), `person_name`, `source`, `source_url`, `published_on_site` bool, `confidence`, `verification_status` (`unknown|valid|invalid|catch_all|risky|disposable`), `verified_at`, `first_seen_at`, `last_seen_at`; unique (`business_id`, `type`, `normalized_value`).
  - `business_categories`: `business_id`, `category_id`, `is_primary`, `confidence`, `source`; PK (`business_id`, `category_id`); partial unique on primary.
  - `business_hours`: `business_id`, `weekday` 0–6, `opens_at` time, `closes_at` time, `source`.
  - `business_media`: `id`, `business_id`, `kind` (`photo|logo|screenshot_desktop|screenshot_mobile|og_image`), `storage_key` or `external_url`, `source`, `license` (`owner_site|provider_restricted|stock|ai_generated|unknown`), `width`, `height`, `dominant_colors` jsonb, `alt_text` jsonb (i18n), `created_at`.
  - `business_reviews`: `id`, `business_id`, `source`, `external_id`, `rating` smallint, `text`, `language`, `published_at`, `has_owner_response` bool, `owner_responded_at`, `expires_at`; **no reviewer names** stored (data minimization).
  - `possible_duplicates` (used by BF-016): `id`, `business_a_id`, `business_b_id`, `score`, `reasons` jsonb, `status` (`open|merged|dismissed`), timestamps.
  - `org_businesses` (crm): `organization_id`, `business_id`, `pipeline_status` (default `new`), `added_via` (`discovery|search|manual|import`), `added_ref`, `do_not_contact` bool, `created_at`, `updated_at`; PK (`organization_id`, `business_id`); index (`organization_id`, `pipeline_status`).
  - Indexes: GiST on `businesses.location`; GIN trigram on `normalized_name`; btree on `website_registrable_domain`, `primary_phone_e164`, `country_code`, `locality`; GIN on `business_contacts.normalized_value` trigram? (only if needed); FK indexes everywhere.
- `@bf/contracts`: `BusinessId`, `BusinessSummarySchema`, `BusinessDetailSchema`, `ContactSchema`, `ProvenanceSchema`, `SourceProvider` enum (`google_places|overture|foursquare|osm|gmaps_scraper|website|manual|import`), `OperatingStatus`, `PipelineStatus` enum (states from DOMAIN.md §3.1).
- Domain (`modules/business-graph/domain`):
  - Value objects with factories that validate and normalize: `PhoneNumber` (libphonenumber-js; region hint from country; E.164; type detection), `WebsiteUrl` (normalize scheme/host/trailing slash/tracking params; `host`; `registrableDomain` via tldts; flag known shared hosts like `*.wixsite.com`, `*.business.site`, `linktr.ee`, `facebook.com` where the registrable domain must not be used for matching), `EmailAddress` (syntax, lowercase, `localPart` role detection: generic list `info|contact|hello|bonjour|reservation(s)|booking|sales|admin|office|team|support` etc. → `generic`), `PostalAddress`, `GeoPoint`, `Provenance`, `BusinessName` (display + normalized; FR/EN legal suffix stripping: `SARL`, `SAS`, `EURL`, `SA`, `Ltd`, `LLC`, `Inc`, `BV`, `NV`, …).
  - `Business` aggregate: `create`, `rehydrate`, `updateField(field, value, provenance)` applying survivorship hooks (strategy injected; full rules in BF-016), `addContact`, `markMerged(intoId)` (read-only afterwards), invariants listed in DOMAIN.md §2; records domain events `business.created`, `business.updated` (field list), `business.merged` (outbox from BF-012 if merged; otherwise recorder hook).
- Application: `BusinessRepository` port + Drizzle adapter (`getById`, `getByIds`, `save` with optimistic concurrency on `version`, `findBySourceRef`), `ContactRepository`, `SourceRecordRepository`; queries `GetBusinessDetailQuery(orgId, businessId)` (404 unless the org tracks the business), `ListTrackedBusinessesQuery` (simple paging; full search is BF-022); command `TrackBusinessCommand(orgId, businessId, addedVia, ref)` (idempotent upsert into `org_businesses`); command `CreateManualBusinessCommand` (creates a `manual` source + golden record; routed through ingestion once BF-016 exists — leave a `TODO(BF-016)`).
- API: `GET /v1/businesses/:id`, `POST /v1/businesses` (manual add), `POST /v1/businesses/:id/track` (idempotent), `GET /v1/businesses/:id/contacts`, `POST /v1/businesses/:id/contacts` (manual contact with provenance `manual`), permissions `business:read` / `business:write`.
- Test factories in `@bf/testing`: `aBusiness()`, `aContact()`, `aSourceRecord()` builders with realistic fake St-Barth-like and generic data.

**Out of scope**
- Taxonomy data and classification (→ BF-015), entity resolution (→ BF-016), geo areas (→ BF-017), search columns/embeddings (→ BF-022), CRM extensions (→ BF-024), enrichment tables (→ BF-026+).

## Requirements
### Functional
- Value objects reject invalid input with typed errors and produce canonical forms (tests with FR/BL/US/NL numbers and URLs).
- `GET /v1/businesses/:id` returns 404 for businesses the workspace does not track.
- Saving a stale aggregate version fails with `ConcurrentModificationError` (409).
### Non-functional
- Detail query p95 < 50 ms locally with joins (contacts, categories, hours, media summary).
- Data minimization: no reviewer identities, no personal social profiles.

## Design
- Provenance map shape: `attributes = { phone: { value, source, sourceRef, confidence, observedAt }, … }`; golden columns mirror the chosen values for indexing.
- Repositories map rows ⇄ aggregates via mappers; no Drizzle types leak into domain.
- Patterns: Aggregate, Value Object, Repository, Factory, Optimistic Concurrency.

## Implementation plan
1. Contracts + value objects with exhaustive unit tests (TDD).
2. Schema + migration (+ indexes) + mappers + repositories (integration tests).
3. `Business` aggregate + domain events hooks (unit tests).
4. Queries/commands + controllers + permissions.
5. Test factories.
6. Update `docs/DOMAIN.md` if any term changed.

## Testing
- Unit: `PhoneNumber` (`+590 590 27 xx xx` style BL landline, `0690…` BL mobile with region `BL`, NL `+31 20 …`, US formats, invalid), `WebsiteUrl` (`HTTP://WWW.Example.COM/?utm_source=x` → canonical; shared hosts flagged), `EmailAddress` role detection, `BusinessName` normalization (accents, legal suffixes), aggregate invariants.
- Integration: repository round-trips; optimistic concurrency; detail query org scoping (404 for untracked); manual business + contact creation; geography stored and read with correct lat/lng.

## Acceptance criteria
- [x] Tables, indexes and migration created; `pnpm db:check` clean.
- [x] Value objects normalize and validate as specified (tests).
- [x] `Business` aggregate enforces invariants and emits events.
- [x] Detail and track endpoints with permissions and org scoping (tests for 403/404).
- [x] Test factories available for later tickets.

## Agent prompt
```text
Implement BF-014 (Business graph data model, value objects and repositories).

Read first: AGENTS.md, docs/adr/0008-global-business-graph-and-org-scoped-crm.md, docs/ARCHITECTURE.md §5–§6,
docs/DOMAIN.md §1–§2, docs/conventions/coding-standards.md §5, docs/conventions/security.md §7 (minimization).
Reuse: @bf/db custom types & tx (BF-003), contracts primitives (BF-004), module template (BF-006).
Skim the tickets this blocks (BF-015, BF-016, BF-017, BF-022, BF-024) so the schema serves them.

Rules:
- Domain value objects are pure TypeScript with exhaustive tests; libphonenumber-js and tldts are allowed
  inside value objects (they are pure libraries).
- Store no reviewer names or personal social profiles.
- Use the module generator from BF-006 and keep the four-layer structure.

Verify: pnpm verify && pnpm test:int && pnpm db:check.
```

## References
- ADR-0008 · docs/ARCHITECTURE.md §6 · docs/DOMAIN.md
- libphonenumber-js: https://gitlab.com/catamphetamine/libphonenumber-js · tldts: https://github.com/remusao/tldts

## Implementation notes
- **Versions** (each published ≥ 1 week before use): `libphonenumber-js` 1.13.15 (`/max` metadata for type
  detection), `tldts` 7.4.18; both used only inside value objects.
- **Split**: part 1/2 data model (contracts, schema + migration 0006, value objects, `Business` aggregate,
  `@bf/testing` factories); part 2/2 API (ports, Drizzle repositories, read model, use cases, controller).
- **Schema**: new tables follow coding-standards §5 naming (`idx_`/`uq_`/`ck_`; earlier tables use Postgres-style
  names — see QUESTIONS.md). Enum columns have CHECK constraints built from the `@bf/contracts` lists (sources
  included, so a new provider needs a migration). Drizzle Kit quotes parameterized custom types, so
  `geography(Point,4326)` is unquoted by hand in 0006. `business_sources.business_id` is nullable (BF-016 persists a
  source before matching). `possible_duplicates` stores each pair once (`a < b`). `categories` is a skeleton;
  `businesses.primary_category_id` FK is already in place. Manual sources/contacts carry `submitted_by_org_id`
  (attribution per ADR-0008, never returned by the API).
- **Domain**: value objects reject with `InvalidValueError` (422, `reason: INVALID_<KIND>`). `WebsiteUrl` keeps scheme
  and host in `canonical`, strips tracking params, rejects IP literals, custom ports and non-ICANN domains; shared
  hosts (`*.wixsite.com`, social networks…) get no registrable domain for matching (`matchKey` uses host + first
  path segment). `BusinessName` strips legal forms at the end, and only unambiguous French forms at the start
  (`Sci Fi Café`, `Beach Club Spa` survive). Social contacts: allow-listed networks, business pages only
  (`linkedin.com/in/…`, `facebook.com/profile.php` rejected). `GeoPoint` rejects `(0, 0)`.
- **Aggregate**: `updateField(value, provenance, survivorship?)` with a default strategy (manual wins, then
  confidence, then recency; full rules in BF-016); provenance kept for every non-null golden field (checked on
  rehydrate); losing observations still update `last_seen_at`; ratings rounded to the column's precision. Events:
  `business.created` (initial values and contacts folded in), one `business.updated` per save with the changed
  fields, `business.merged`. Merged records are read-only. "Exactly one primary category" is "at most one" until
  BF-015 classifies (partial unique index; DOMAIN.md updated).
- **Persistence**: `save()` inserts new aggregates (`isNew`, not `version = 0`), updates changed rows with
  `WHERE version = n` (stale → `ConcurrentModificationError`, 409), and upserts contacts on their own key —
  adding a contact does not bump the version, so concurrent additions never conflict. Contact upserts keep the
  first source, raise confidence and set `published_on_site` once any source saw it on the site.
- **API**: `GET /v1/businesses` (tracked, newest first, keyset cursor with microsecond precision),
  `POST /v1/businesses`, `GET /v1/businesses/:id`, `POST /v1/businesses/:id/track` (201 added / 200 already tracked,
  409 for merged records), `GET|POST /v1/businesses/:id/contacts`. Everything except track returns 404 unless the
  workspace tracks the business. Manual add, track and contact add are audit-logged. Manual contacts accept no
  person names (contacts are shared facts). `CreateManualBusinessCommand` has a `TODO(BF-016)` to go through
  ingestion.
- **Performance**: detail read model p95 3.1 ms, HTTP p95 8.6 ms locally (requirement < 50 ms).
- **Reviews** (fixed): IP/port websites, social allow-list and personal profiles, workspace attribution, cursor
  bounds, contact-only saves, `isNew`, verbatim manual address, legal-form stripping, rating precision, contact
  provenance refresh, `website_host` and listing indexes, source CHECKs, track audit.
- **Tests**: API 291 unit (business-graph domain 81, 92% branches) / 106 integration (14 business-graph),
  `@bf/testing` factories 5.
