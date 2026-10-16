---
id: BF-031
title: Scoring engine (feature registry, offer profiles, explainability, recompute)
milestone: M2 Understand
epic: scoring
type: feature
priority: P0
size: L
depends_on: [BF-027, BF-028, BF-029, BF-030]
blocks: [BF-032, BF-058, BF-059]
areas: [api, worker]
---

# BF-031 — Scoring engine (feature registry, offer profiles, explainability, recompute)

## Context
The partner needs a ranked answer to "who should I contact next, for which offer, and why?" ([PRD J2](../PRD.md#5-key-user-journeys)). Scores are per **offer** (`new_website`, `website_redesign`, `ai_receptionist`, `booking_system`, `local_seo`) and per workspace (profiles are org-scoped), explainable (contributions + reasons), versioned, and later replaceable by an outcome-trained model (BF-059) — which needs the exact **feature snapshots** used at decision time. Inputs come from the business graph, website audits, email verification and review insights.

## Goal
A deterministic, versioned scoring engine with a typed feature registry, configurable offer profiles (weights, transforms, gates, tiers), human-readable explanations (EN/FR), event-driven and bulk recompute, stored feature snapshots, and denormalized score/tier for fast listing.

## Scope
**In scope**
- Feature registry (`scoring/domain/features/*`): each feature `{ key, type: number|boolean|enum, description (EN/FR), source, compute(facts) → value | null, missing: 'null'|'default:<v>' }`. Initial features (≥ 25):
  - presence: `has_website`, `website_status` (enum), `website_quality_score`, `psi_mobile_performance`, `lcp_mobile_seconds`, `vision_overall`, `has_https`, `site_freshness_years`, `has_booking_tool`, `has_online_menu`, `has_contact_form`, `has_language_gap_for_market`;
  - business: `category_offer_relevance(offer)`, `appointment_based`, `tourism_facing`, `price_level`, `rating_avg`, `review_count_log`, `owner_response_rate`, `multi_location`, `ad_pixels_present`, `operating_status`;
  - pain: `pain_share(tag)` for each pain tag, `sentiment_avg`;
  - reachability: `has_verified_email`, `has_generic_email_only`, `has_phone`, `has_whatsapp`;
  - workspace: `do_not_contact`, `pipeline_status`, `days_since_last_contact` (for re-engagement profiles later).
- `FactsAssembler`: builds an immutable `BusinessFacts` snapshot from the business graph, latest audit, latest insights and contacts (single query per batch, no N+1).
- Profile model (`@bf/contracts` `ScoringProfileConfigSchema`): `offer`, `weights` (feature → weight), `transforms` (per feature: `linear{min,max}`, `piecewise{points}`, `log{base}`, `boolean{true,false}`, `enumMap{value→score}`, `inverse`), `gates` (spec DSL: e.g. `{ all: [{ feature: 'operating_status', eq: 'closed_permanently' }] } → exclude`; `cap` effects), `tiers` thresholds (A/B/C), `normalization` (weighted sum → 0–100), `reasonTemplates` (feature → EN/FR template with value placeholders).
- Seeded built-in profiles (versioned, read-only; workspaces duplicate to customize): `new_website`, `website_redesign`, `ai_receptionist`, `booking_system`, `local_seo` — with weights documented in `docs/scoring/profiles.md` (rationale for each feature weight).
- Engine: `score(profile, facts) → { score, tier, contributions[{feature, rawValue, transformed, weight, contribution}], reasons[] (top 3 positive/negative), gated?: {rule, effect} }` — pure, deterministic, unit-tested; `do_not_contact` → tier `X`.
- Tables: `scoring_profiles` (`id`, `organization_id` null for built-ins, `offer`, `name`, `builtin` bool, `active_version`), `scoring_profile_versions` (`profile_id`, `version`, `config` jsonb, `created_by`, `created_at`, immutable), `business_scores` (`organization_id`, `business_id`, `profile_id`, `profile_version`, `score`, `tier`, `contributions` jsonb, `reasons` jsonb, `features` jsonb (snapshot), `facts_hash`, `computed_at`; PK (`organization_id`, `business_id`, `profile_id`)), `business_score_history` (append-only, for ML training and trend: same columns + `id`).
- Workspace setting: `primaryScoringProfileId` → denormalized `org_businesses.score/tier/score_profile_id` (used by listing sorts/filters/facets).
- Recompute:
  - Subscribers: `business.enriched`, `business.updated`, `org_business.status_changed`, `crm.do_not_contact_set`, profile version activation → enqueue `scoring.compute` for affected (org, business, profiles) — idempotent by `facts_hash + profile_version`.
  - Bulk recompute command per profile version with progress (realtime) — 10k businesses < 60 s target.
  - `score.updated` event (with old/new tier) → realtime + activity entry (BF-024 renderer).
- APIs: `GET /v1/businesses/:id/scores` (all profiles for this workspace), `GET /v1/scoring/profiles`, `GET /v1/scoring/profiles/:id/versions/:v`, `POST /v1/scoring/profiles/:id/recompute` (`scoring:manage`), `POST /v1/scoring/explain` (score a business with a draft config without persisting — used by BF-032 preview).
- Search integration: tiers/score filters and sort already in BF-022 contract; ensure denormalized columns populate; facet by tier.

**Out of scope**
- Profile editor UI and score visualizations (→ BF-032). Outcome-trained model (→ BF-059).

## Requirements
### Functional
- Same facts + same profile version → same score (determinism test).
- Monotonicity: increasing a feature with positive weight (and monotone transform) never decreases the score (property test).
- Gates override scores as configured; `do_not_contact` always tier X.
### Non-functional
- Batch scoring: assemble facts in bulk (≤ 3 queries per 1,000 businesses); compute in memory; upsert in batches.

## Design
```
modules/scoring/
├── domain/{features/{registry.ts, *.feature.ts}, transforms.ts, gates.ts, engine.ts, reasons.ts, profile.ts}
├── application/{commands/{recompute,activate-version}.command.ts, queries/*, subscribers/*}
├── infrastructure/{facts-assembler.sql.ts, repositories/*, processors/compute.processor.ts}
└── interface/http/*
docs/scoring/profiles.md
```
- Patterns: Strategy (transforms), Specification (gates DSL), Registry (features), Interpreter (config → scoring function), Memento-like snapshot (features stored with scores).

## Implementation plan
1. Contracts (profile config, score DTOs, events).
2. Feature registry + transforms + gates + engine + reasons (TDD, property tests with fast-check).
3. Built-in profiles + docs with rationale.
4. Tables + facts assembler (bulk SQL) + repositories.
5. Subscribers, processors, bulk recompute with progress, denormalization.
6. APIs incl. explain endpoint.

## Testing
- Unit/property: determinism, monotonicity, gate precedence, tier thresholds, reason selection, missing-value strategies.
- Golden tests: 12 fixture businesses (built with `@bf/testing` factories) → expected tier per built-in profile.
- Integration: event → recompute → `business_scores` + history + denormalized columns + `score.updated`; bulk recompute performance (10k synthetic businesses) reported.

## Acceptance criteria
- [x] Feature registry (≥ 25 features), transforms, gates, explainable engine with EN/FR reasons.
- [x] Built-in offer profiles seeded with documented rationale.
- [x] Scores, history and feature snapshots persisted; denormalized score/tier for listing.
- [x] Event-driven and bulk recompute; performance target met.
- [x] Explain endpoint for drafts.

## Implementation notes

Two stacked PRs: part 1 (#93) the pure core, part 2 the persistence, recompute and APIs.

- **Contracts** (`scoring.ts`): 44 features (`FEATURE_DEFINITIONS`: group, type, unit, range, pivot, EN/FR description
  and reason texts, source, missing default; keys append-only, `FEATURE_SET_VERSION`), transforms (linear, inverse,
  non-decreasing piecewise, log without `base` — DECISION: the normalized ratio is the same in every base, boolean,
  enumMap), gate DSL (one operator per leaf, all/any/not), profile config (`kind: 'rules'`, per-profile `missing`
  values, reason templates) validated by `profileProblems` (shared with BF-032; array paths), score DTOs (each
  contribution says what stood in: `imputed`; `gated.applied`), events `score.updated` and `org_business.tracked`,
  jobs `scoring/compute` and `scoring-recompute/recompute`.
- **Engine** (`scoring/domain`, pure): weighted sum ÷ positive weights, clamped; registry defaults, then profile
  `missing` values; gates (exclusion beats caps, lowest cap wins, do-not-contact always X); tiers; reasons (three each
  way, profile texts first, a filled-in value reads only a `missing` text). Property tests (seeded): determinism,
  monotonicity, do-not-contact. Golden table: 12 fictional businesses × 5 profiles (docs/scoring/profiles.md).
- **Built-in profiles**: `new_website`, `website_redesign`, `ai_receptionist`, `booking_system`, `local_seo`, each v1
  (digest-pinned), seeded at boot with stable ids (`BUILTIN_PROFILE_IDS`).
- **Storage** (migration `0024_scoring`): `scoring_profiles`, `scoring_profile_versions` (immutable: UPDATE refused by
  a trigger), `business_scores` (PK org × business × profile; features, feature-set version, vector hash),
  `business_score_history` (append-only), `scoring_workspace_settings` (primary profile).
- **DECISION — primary profile** lives in the scoring module's own table (`PUT /v1/scoring/primary-profile`), not in
  `org_settings`: validating a profile id from the workspace module would read another module's table. Default: the
  built-in new-website profile.
- **Facts assembler**: three queries per batch of 500 (cross-module read model, DECISION comment). Last contact =
  last pipeline move of a contacted business until outreach records sends (DECISION).
- **Recompute**: subscribers enqueue `scoring/compute` jobs keyed by the event (`org_business.tracked` — a new event,
  `org_business.status.changed`, `crm.do_not_contact.set` for the workspace; `business.enriched`, `business.updated`
  for every tracking workspace). Bulk: `POST /v1/scoring/profiles/:id/recompute` (202, `scoring:manage`) pages through
  the workspace with throttled realtime progress (`scoring.recompute.progressed`); 10,000 synthetic businesses in
  ≈ 3.8 s (integration suite, target < 60 s). Unchanged vectors are skipped (a forced recompute rewrites the current
  row without a history row); at most one waiting and one running recompute per workspace and profile; writes are
  serialized per business (advisory locks; older facts never overwrite newer ones). Merges rescore the survivor; a
  new built-in version recomputes every workspace.
- **DECISION — contacts are global facts** in scoring (ADR-0008), as on the business page.
- **DECISION — history is kept**: profile versions with scores cannot be deleted (`no action`), archive instead.
- **`score.updated`**: only when the primary profile's tier moves (a first score is no change; a bulk first scoring
  would flood the outbox) → CRM timeline (`Tier moved from B to X`). Pages refresh on `scoring.scores.updated`
  (realtime, sent after small compute batches).
- **APIs**: `GET /v1/businesses/:id/scores`, `GET /v1/scoring/profiles`, `GET /v1/scoring/profiles/:id/versions/:v`
  (business:read), `POST /v1/scoring/profiles/:id/recompute`, `PUT /v1/scoring/primary-profile`,
  `POST /v1/scoring/explain` (scoring:manage).

## Agent prompt
```text
Implement BF-031 (Scoring engine).

Read first: AGENTS.md, docs/DOMAIN.md (Offer, Feature vector, Scoring profile, Score/Tier), docs/PRD.md (J2, FR-34),
docs/ARCHITECTURE.md §8 (F3). Reuse: audits (BF-030), insights (BF-029), contacts verification (BF-028),
enrichment events (BF-027), listing denormalized columns (BF-022), activity renderers (BF-024).

Rules:
- The engine is pure and deterministic; prove determinism and monotonicity with property-based tests.
- Every score must be explainable in plain EN/FR language to a non-technical partner.
- Store the exact feature snapshot with each score (needed for BF-059); never recompute history.
- Avoid N+1: assemble facts in bulk.

Verify: pnpm verify && pnpm test:int; include the golden-test table (business → tier per profile) and the bulk
recompute timing in the PR.
```

## References
- docs/DOMAIN.md · docs/PRD.md FR-34 · docs/ARCHITECTURE.md §8
- fast-check: https://fast-check.dev/
