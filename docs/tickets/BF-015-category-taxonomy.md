---
id: BF-015
title: Category taxonomy (EN/FR), provider mappings and AI classification
milestone: M1 Find & List
epic: business-graph
type: feature
priority: P0
size: M
depends_on: [BF-013, BF-014]
blocks: [BF-016, BF-021, BF-022, BF-040, BF-049]
areas: [api, db, ai]
---

# BF-015 — Category taxonomy (EN/FR), provider mappings and AI classification

## Context
Users search by niche ("salons", "quincailleries", "villa rental agencies"); providers each use their own categories (Google place types, Overture `basic_category`/`taxonomy`, Foursquare category ids, OSM tags). We need one hierarchical taxonomy with English and French labels and synonyms, mappings from every provider, an AI fallback for unmapped cases, and category embeddings to ground NL intent parsing (BF-021). The `categories` table skeleton exists from BF-014.

## Goal
A curated, bilingual taxonomy (~250–350 categories) relevant to local businesses — including Caribbean/Saint-Barthélemy tourism niches — with provider mappings, a classifier service (mapping → synonyms → LLM fallback), category embeddings, and APIs for the UI.

## Scope
**In scope**
- Complete `categories` table: `slug` unique, `parent_id`, `path` ltree (from slugs, e.g. `food_drink.cafe`), `labels` jsonb `{en, fr}`, `synonyms` jsonb `{en:[], fr:[]}`, `description`, `icon` (Tabler icon name), `attributes` jsonb (`appointmentBased`, `hospitality`, `retail`, `regulated`, `tourismFacing`), `offer_relevance` jsonb (offers from DOMAIN.md with weights 0–1, used by scoring/compliance relevance), `embedding` vector, `embedding_model`, `sort_order`, `is_active`; GiST index on `path`; trigram GIN on labels/synonyms text (generated column of all labels+synonyms, unaccented).
- `category_mappings`: `id`, `provider`, `provider_key`, `category_id`, `confidence`, `origin` (`seed|llm|human`), `status` (`active|needs_review|rejected`), `created_at`, `reviewed_by`; unique (`provider`, `provider_key`).
- Seed data (versioned, reviewed in PR): `packages/db/seed/taxonomy/taxonomy.v1.yaml` (nodes with labels, synonyms, attributes, offer relevance) and mapping files `mappings/google_places.v1.yaml` (Places API (New) primary types), `overture.v1.yaml` (basic_category values), `foursquare.v1.yaml` (top-level and relevant leaf ids), `osm.v1.yaml` (`amenity=*`, `shop=*`, `craft=*`, `tourism=*`, `office=*`, `leisure=*`). Must include niches such as: hair salon, barber, nail salon, spa, beauty salon, massage, fitness/yoga studio, café, bakery, restaurant (by cuisine optional), bar, beach club, nightclub, hotel, guest house, villa rental agency, real estate agency, property management, concierge, boat/yacht charter, water sports, scuba diving, car/scooter rental, taxi, event/wedding planner, photographer, florist, jewelry, fashion boutique, swimwear, art gallery, wine & spirits shop, grocery/supermarket, deli, hardware store (quincaillerie), building supplies, electrician, plumber, HVAC/air conditioning, pool maintenance, landscaping, cleaning services, laundry, pharmacy, medical clinic, dentist, physiotherapist, veterinarian, lawyer, accountant, insurance agency, bank, travel agency, tour operator, printing, IT services, marketing agency, school/tutoring.
- Seed module (BF-003 seed runner): idempotent upsert of taxonomy + mappings by version; mappings never overwrite `human`-origin rows.
- `CategoryClassifier` (business-graph module): `classify({ providerCategories: {provider, key}[], name, websiteSnippet?, locale })` → `{ primary, secondary[], confidence, origin, needsReview }`:
  1. exact mapping lookup (active) → highest confidence;
  2. synonym/label match on name and provider labels (accent-insensitive trigram + token rules, FR/EN);
  3. LLM fallback: task `taxonomy.classify_business` (fast tier) choosing among top-k candidates retrieved by embedding similarity (k=12) — never inventing categories; returns ids + confidence + rationale; new provider keys learned this way are stored as `origin=llm, status=needs_review`.
- Category embeddings job: embed `labels.en + labels.fr + synonyms` per category (purpose `category`), stored in `categories.embedding`; re-embed on change; `findCandidateCategories(text, k)` hybrid (vector + trigram) used by BF-021.
- APIs: `GET /v1/categories` (tree with localized labels, counts optional), `GET /v1/categories/search?q=&locale=` (typeahead), `GET /v1/categories/mappings?status=needs_review` and `PATCH /v1/categories/mappings/:id` (approve/reassign/reject; `settings:manage`).
- Web: small admin page `/settings/taxonomy` to review LLM-proposed mappings (approve/reassign) and browse the tree; reusable `CategoryPicker` (tree combobox, multi-select, EN/FR search) in `@bf/ui` for BF-023.
- Eval set `packages/ai/evals/taxonomy.classify_business/` (≥ 60 rows; EN/FR; ambiguous names like "Le Ti St Barth" (restaurant/bar), "Hugo's Hardware & Pool"), threshold primary accuracy ≥ 0.9.

**Out of scope**
- Using the classifier during ingestion (→ BF-016 calls it). Intent parsing (→ BF-021).

## Requirements
### Functional
- Every seeded category has EN and FR labels; tree depth ≤ 4; slugs stable (renames add synonyms, never change slugs).
- Classifier never returns a category id that does not exist or is inactive.
### Non-functional
- Mapping lookup path < 2 ms; LLM fallback results cached (by provider key + name hash).

## Design
- Strategy chain for classification (Chain of Responsibility: `MappingStep → SynonymStep → LlmStep`), each returning a candidate with confidence; the first above threshold wins, otherwise the best with `needsReview`.
- Taxonomy versioning: `taxonomy_version` recorded in `app_meta`/seed state; changes via new YAML version + migration-like seed.

## Implementation plan
1. Design the tree (draft YAML) — include rationale in the PR for top-level groups; get labels right in French.
2. Schema completion + seed runner module + mapping files.
3. Classifier steps with unit tests; LLM task + prompt + fixtures + eval set.
4. Embedding job + candidate search.
5. APIs + admin page + `CategoryPicker`.

## Testing
- Unit: synonym matching (accents, plurals, FR/EN), mapping precedence (human > seed > llm), classifier chain decisions with fake gateway.
- Integration: seed idempotency (run twice → no changes), `path` descendant queries, typeahead search ranking ("quincaillerie" → hardware store; "coiffeur" → hair salon).
- Eval: `pnpm eval --task taxonomy.classify_business` ≥ threshold (report attached).

## Acceptance criteria
- [x] Taxonomy seeded with EN/FR labels and synonyms, including the niches listed above.
- [x] Provider mapping files for Google Places, Overture, Foursquare and OSM seeded; human mappings never overwritten.
- [x] `CategoryClassifier` chain with LLM fallback constrained to candidates; unknown keys stored as `needs_review`.
- [x] Category embeddings + candidate search available for BF-021.
- [x] APIs, admin review page and `CategoryPicker` component (EN/FR).
- [x] Eval meets threshold.

## Agent prompt
```text
Implement BF-015 (Category taxonomy, provider mappings and AI classification).

Read first: AGENTS.md, docs/ARCHITECTURE.md §6 and §9, docs/conventions/ai-engineering.md, docs/DOMAIN.md (Category,
Offer). Reuse: categories skeleton + business graph (BF-014), @bf/ai gateway + eval harness (BF-013), seed runner (BF-003).

Rules:
- Verify the current Google Places (New) place-type list, Overture basic_category/taxonomy values (the
  `categories` property is removed in the September 2026 Overture release) and Foursquare category ids from
  official sources before writing mapping files; cite sources in the YAML headers.
- French labels must be natural French used in the French Caribbean (e.g. "quincaillerie", "salon de coiffure",
  "agence de location de villas"), not literal translations.
- The LLM may only choose among provided candidate ids; validate and reject anything else.

Verify: pnpm verify && pnpm test:int; pnpm db:seed twice (idempotent); eval report attached.
```

## References
- docs/ARCHITECTURE.md §6, §9 · ADR-0013 · docs/conventions/ai-engineering.md
- Google Places types: https://developers.google.com/maps/documentation/places/web-service/place-types · Overture places taxonomy: https://docs.overturemaps.org/guides/places/ · Foursquare categories: https://docs.foursquare.com/data-products/docs/categories · OSM Map Features: https://wiki.openstreetmap.org/wiki/Map_features

## Implementation notes
- **Split**: part 1/3 data (contracts, `categories` completion + `category_mappings` + `app_meta` in migration 0007,
  taxonomy/mapping YAML, loader + seed module); part 2/3 classification (synonym matcher, chain, LLM task + prompt +
  eval, candidate search, embeddings job, APIs); part 3/3 web (`CategoryPicker`, `/settings/taxonomy`).
- **Taxonomy v1**: 337 categories in 20 top-level groups (depth ≤ 3), EN/FR labels (French Caribbean usage:
  quincaillerie, lolo, pressing/laverie…), 2–8 synonyms per language on every leaf, Tabler icons, inherited
  attributes and offer relevance. Includes every niche the ticket lists plus island ones (hurricane shutters, cistern
  service, villa caretaking, yacht provisioning, water taxi). Rationale comments above each group.
- **Mappings** (sources and retrieval date in each file header, lists fetched 2026-10-15): Google Places (New)
  Table A 375/478 keys, Overture `basic_category` (release 2026-09-23.0) 175/298, Foursquare (24-hex ids,
  docs' category CSV) 902/1105, OSM Map Features 369/557. Non-business keys (government, worship, transit, natural
  features, adult/gambling) are skipped, not forced.
- **Seed**: `pnpm db:seed --only taxonomy` (all environments) upserts by slug / (provider, key); unchanged rows are
  not touched (verified: second run writes nothing, `updated_at` unchanged); missing slugs are deactivated; `human`
  mappings are never overwritten; dropped seed mappings are retired. `app_meta.taxonomy_version` records the version.
  `yaml` 2.9.1 added for parsing.
- **Search text**: generated column `search_text` (`f_unaccent(lower(labels + synonyms))`) with a trigram GIN index;
  `path` has a GiST index; slug and depth CHECKs.
- **Classifier** (`CategoryClassifier`, exported for BF-016): active mapping (human > seed > llm, then confidence) →
  whole-word label/synonym match on name and provider labels (FR/EN plural folding, accent-insensitive; top-level
  groups excluded) → LLM (`taxonomy.classify_business`, fast tier) choosing among ≤ 16 candidates (earlier picks +
  hybrid retrieval). Accept threshold 0.75; LLM confidence capped at 0.85; answers outside the candidates are
  discarded; never returns an unknown/inactive category. The LLM's pick is stored as an `llm` mapping
  (`needs_review`) only when exactly one specific, well-formed provider key is unmapped. Model errors (no key,
  budget) fall back to the best earlier proposal with `needsReview`. Active taxonomy + mappings are cached in
  memory (60 s / invalidated on review): mapping lookups are map reads (≪ 2 ms). LLM answers are cached by the
  gateway (global scope, 30 days).
- **Candidates** (`CategoryCandidateSearch.find(texts, k)`, for BF-021): trigram per short piece fused (RRF) with
  cosine similarity on category embeddings when any exist for the configured model; degrades to trigram only.
- **Embeddings**: `taxonomy.embed-categories` job (new `taxonomy` queue) enqueued at worker start; embeds active
  categories whose text hash or model changed (purpose `category`); skips quietly without a key or budget.
- **APIs**: `GET /v1/categories` (tree, locale), `GET /v1/categories/search` (typeahead: label/synonym prefix in
  memory + DB trigram), `GET /v1/categories/mappings` (`settings:manage`; `canReview`; rationale shown to platform
  operators only), `PATCH /v1/categories/mappings/:id` (approve/reassign/reject → `origin = human`, confidence 1,
  audited). **Decision**: review requires a platform operator in addition to `settings:manage`, because mappings
  are shared by every workspace (QUESTIONS.md).
- **Web**: `CategoryPicker` in `@bf/ui` (tree combobox, single/multi, accent-insensitive search on labels and
  keywords, keyboard, screen-reader selection state); `/settings/taxonomy` review queue + tree (EN/FR).
- **Eval**: 77 rows (40 FR / 37 EN; ambiguous, misleading/generic provider, name-only, website, no-fit, injection).
  Replay report: `primary.accurate` 0.961 (threshold 0.9), `primary.valid_id` 1.0. No provider keys locally, so
  the fixtures are hand-written (3 deliberate misses); the nightly evals workflow runs real models.
- **Reviews** (fixed): human decisions get confidence 1, plural folding (`bureaux`, `taxis`), per-piece trigram
  retrieval, picker ids out of the search haystack + a11y, learned mappings limited to one specific key the model
  saw, approve of an inactive category refused, rationale hidden from non-operators, `provider_key` length CHECK,
  richer review audit metadata.
- **Tests**: API 316 unit / 118 integration (taxonomy 12: tree, typeahead incl. typo, review authz/operator,
  human mapping survives re-seed, classifier with seeded data, embeddings + hybrid candidates); db loader 7 + seed
  integration 4; `@bf/ai` replay eval; `@bf/ui` picker 4; web 64.
