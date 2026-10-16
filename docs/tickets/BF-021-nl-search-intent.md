---
id: BF-021
title: Natural-language search intent parsing (EN/FR) grounded in the taxonomy
milestone: M1 Find & List
epic: search-listing
type: feature
priority: P0
size: M
depends_on: [BF-013, BF-015, BF-017]
blocks: [BF-023]
areas: [api, ai]
---

# BF-021 — Natural-language search intent parsing (EN/FR) grounded in the taxonomy

## Context
The main entry point for the sales partner is a prompt such as *"salons de coiffure et cafés à Gustavia sans site web"* or *"villa rental agencies in St Barth with a slow website and an email"*. The prompt must become a structured **search intent** that the user can see and edit as chips ([DOMAIN.md](../DOMAIN.md#1-glossary)). Grounding: categories come only from our taxonomy (candidates retrieved via embeddings/trigram, BF-015); locations are resolved by `LocationResolver` (BF-017). LLM conventions: [ai-engineering.md](../conventions/ai-engineering.md).

## Goal
`POST /v1/search/intent` returns a validated `SearchIntent` with resolved location candidates, confidence, and a clarification question when needed — accurate on EN and FR prompts per the eval thresholds.

## Scope
**In scope**
- `@bf/contracts` `SearchIntentSchema`:
  - `mode`: `listings|discover|both` (default `both` when the user asks to "find"; `listings` when filtering existing pipeline, e.g. "my qualified cafés").
  - `categories`: `{ ids: CategoryId[], includeDescendants: boolean }`.
  - `keywords`: string[] (free-text terms not mapped to categories, e.g. "vegan", "rooftop").
  - `location`: `{ text: string, resolution: LocationResolution | null } | null`.
  - `filters`: `website` (`any|none|has|weak` — `weak` resolved later by audit scores), `minRating`, `maxRating`, `minReviews`, `maxReviews`, `hasEmail`, `hasPhone`, `emailVerified`, `languages` (site language), `priceLevels`, `painSignals` (enum list from DOMAIN), `scoreProfile` + `minScore` + `tiers`, `pipelineStatuses`, `tags`, `addedWithinDays`.
  - `sort`: `relevance|score|rating|reviews|distance|recent` + direction.
  - `limit` (for discovery: target result count).
  - `needsClarification`: `{ question, options?: string[] } | null`; `confidence` 0–1; `warnings` string[]; `language` (`en|fr`).
- Task `search.parse_intent` (smart tier) with prompt `search.parse_intent.v1.md`:
  - Inputs: prompt (trusted user input, still length-limited), UI locale, workspace default country, candidate categories (top 15 from `findCandidateCategories` over EN+FR labels/synonyms), allowed enum values for filters.
  - Rules: choose categories only from candidates; map vague niches to the closest category + keyword; never invent locations — copy the location phrase verbatim into `location.text`; set `needsClarification` when two very different interpretations exist.
- Service `SearchIntentService.parse(prompt, ctx)`:
  1. normalize + detect language (`franc` or similar, short-text tolerant);
  2. candidates (BF-015);
  3. LLM task;
  4. validate + post-process (dedupe categories, collapse parent+child to parent with `includeDescendants`, clamp numeric filters);
  5. `LocationResolver.resolve(location.text, { countryHint: workspace default })` → attach candidates; ambiguous → `needsClarification` with options;
  6. cache result per (org, normalized prompt) for 1 h.
- Endpoint `POST /v1/search/intent` `{ prompt, locale }` → `{ intent, resolvedArea?, alternatives? }` (`business:read`).
- Deterministic fallback when the AI budget is exhausted or provider down: rule-based parser (category synonym match + location phrase heuristics + simple filters like "no website"/"sans site") returning lower confidence and a warning.
- Eval set `packages/ai/evals/search.parse_intent/` with ≥ 80 prompts: EN/FR, St Barth places, NL/US postcodes, filters ("rating below 4", "moins de 20 avis", "with email", "sans site web"), multi-category, keyword-only ("rooftop bar"), ambiguous ("Saint-Jean"), pipeline queries ("my qualified spas"). Metrics & thresholds: category set F1 ≥ 0.90; location text exact ≥ 0.95; filters exact-match ≥ 0.90; mode accuracy ≥ 0.95; clarification precision ≥ 0.8.

**Out of scope**
- Running the search (→ BF-022) or discovery (→ BF-020); UI chips (→ BF-023).

## Requirements
### Functional
- FR and EN prompts produce equivalent intents for equivalent meaning (paired eval rows).
- The output never contains category ids outside the candidate list (validated; violation → repair → fallback).
### Non-functional
- p95 latency < 2.5 s (smart tier) with cache hits < 50 ms.
- Cost per parse tracked in `llm_calls` under task `search.parse_intent`.

## Design
- Patterns: Facade (`SearchIntentService`), Chain (LLM → fallback parser), Specification (filters later translated to SQL by BF-022).
- Keep the intent → query translation out of this ticket; intent is a pure description.

## Implementation plan
1. Contracts + enums; fallback rule-based parser with unit tests (also used offline).
2. Prompt v1 with EN/FR few-shot examples (fake businesses/places only).
3. Service pipeline + caching + location resolution integration.
4. Eval dataset + scorers + run; iterate prompt to meet thresholds.
5. Endpoint + tests with fake gateway fixtures.

## Testing
- Unit: fallback parser; post-processing (parent/child collapse, clamping); candidate-only validation.
- Integration: endpoint with fake gateway fixtures for 10 representative prompts; ambiguity flow; budget-exhausted fallback.
- Evals: attach report meeting thresholds.

## Acceptance criteria
- [x] `SearchIntentSchema` and endpoint implemented; outputs validated and grounded.
- [x] Location resolution attached with ambiguity handling.
- [x] Fallback parser works without AI.
- [ ] Eval thresholds met (report attached). *Replay report attached (all thresholds met on hand-written
  fixtures); a measurement on a real model is pending an API key — see the notes.*

## Implementation notes (BF-021)
- **Pipeline** (`SearchIntentService`, Facade + Chain): candidates (top 15 from `CategoryCandidateSearch` over
  the prompt split into pieces and single trade words, up to 12 pieces) → `search.parse_intent` (smart tier)
  → grounding/post-processing → `LocationResolver` (workspace country as hint) → response. The model answers
  with category **slugs**; post-processing maps them to ids, drops descendants of a selected ancestor, clamps
  and orders numeric filters (a rating of 0 means no filter), and deduplicates lists.
- **`includeDescendants` is always `true`** (`DECISION(BF-021)`): "restaurants" includes pizzerias.
- **Grounding**: if *every* category the model returned is outside the candidates, the answer is discarded and
  the rule-based reading is used; *partially* invalid ids are dropped with a `CATEGORIES_OUTSIDE_CANDIDATES`
  warning.
- **Language detection is a heuristic, not franc**: statistical detectors need ~50+ characters and most
  prompts are shorter. It counts French and English function/trade words (French-only words `sans`, `avec`,
  `dans` weigh 2; false friends such as `note`, `location`, `plus`, `en` are not counted), accents tip ties to
  French, and the UI locale breaks remaining ties.
- **Fallback parser** (no key, budget spent, provider down, or all-invalid categories): category label/synonym
  matching, a place after a preposition (case-insensitive prepositions, capitalised place or postcode, cut at
  capitalised stop words; bare `a` only in French; `à la Rochelle` → `la Rochelle`), and the common filters
  (website, email, phone, ratings, review counts, pipeline statuses after a possessive, recency, sort, target
  count). Confidence 0.4 with an `AI_UNAVAILABLE_FALLBACK` warning. Lowercase place names are left to the model.
- **Location**: an unresolved place adds `LOCATION_NOT_FOUND`; a geocoder notice adds
  `LOCATION_CANDIDATES_INCOMPLETE`; several candidates with none chosen become the clarification question
  (unless the model already asked one) with up to 4 options.
- **Cache**: Valkey, 1 h, keyed by workspace + normalized prompt + UI locale + workspace country. Best effort
  (a Valkey error or a corrupt/outdated entry is a miss). Degraded answers are **not** cached: fallback
  readings, no candidates, `LOCATION_NOT_FOUND` / `LOCATION_CANDIDATES_INCOMPLETE`. The key has no taxonomy
  version, so a taxonomy change can be invisible for up to an hour.
- **Eval** (`packages/ai/evals/search.parse_intent/`, 85 EN/FR rows): scorers category F1, location exact,
  active-filter exact match, mode exact, clarification precision **and recall** (`DECISION(BF-021)`: recall
  ≥ 0.8 so a model that never asks cannot pass precision vacuously), and ids-within-candidates. A scorer may
  return `null` ("not applicable"); a scorer that applied to no row scores 1, an eval with no rows scores 0.
  The replay fixtures in `packages/ai/fixtures/search.parse_intent/v1` are **hand-written** (no LLM key was
  available), so the replay report checks the harness and scorers, not the model. A real measurement needs
  `pnpm eval --task search.parse_intent --record` with an API key; thresholds are unverified on a real model.
- **Tests**: `TEST_ENV` now sets `GEOCODER_PROVIDER=none` so integration tests never call the real Nominatim;
  the geo integration test opts back in against its local fake server.
- **Follow-ups**: real-model eval run and prompt iteration; p95 latency (< 2.5 s) not measured without a key;
  taxonomy version in the cache key; lowercase place names in the fallback parser.

## Agent prompt
```text
Implement BF-021 (Natural-language search intent parsing).

Read first: AGENTS.md, docs/conventions/ai-engineering.md (all), docs/DOMAIN.md (Search intent, Offer, Pain signal),
docs/ARCHITECTURE.md §8 (F1) and §9. Reuse: @bf/ai gateway + eval harness (BF-013), candidate categories (BF-015),
LocationResolver (BF-017).

Rules:
- The model chooses only from provided candidate category ids; validate strictly.
- Write the eval dataset early (≥ 80 rows, EN/FR) and iterate the prompt against it; attach the final report.
- Few-shot examples must use invented business names; no real people or real email addresses.

Verify: pnpm verify && pnpm test:int; pnpm eval --task search.parse_intent (report in PR).
```

## References
- docs/conventions/ai-engineering.md · docs/ARCHITECTURE.md §8–§9 · ADR-0011
