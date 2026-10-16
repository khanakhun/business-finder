---
id: BF-029
title: Review mining and pain signals (licensing-gated, privacy-preserving)
milestone: M2 Understand
epic: enrichment
type: feature
priority: P1
size: M
depends_on: [BF-013, BF-027]
blocks: [BF-031, BF-040]
areas: [api, worker, ai]
---

# BF-029 — Review mining and pain signals (licensing-gated, privacy-preserving)

## Context
Reviews reveal problems a web/AI offer can solve: "impossible to book online", "nobody answers the phone", "website doesn't work", "menu not online". These **pain signals** strengthen scoring (BF-031) and personalize outreach (BF-051). But review text is licensed content: Google Places reviews come with strict terms; scraped reviews are flagged; some sources allow nothing. [ADR-0013](../adr/0013-discovery-providers-and-data-licensing.md) requires per-provider licensing profiles, and [security.md §7](../conventions/security.md#7-logging--privacy) requires minimization (no reviewer names).

## Goal
A licensing-gated review mining step that turns available review text into aggregated, anonymous pain signals (fixed taxonomy), sentiment, owner-response rate and rating trend — storing derived insights and short evidence snippets only where allowed, with an eval-backed LLM classifier.

## Scope
**In scope**
- Pain-signal taxonomy in `@bf/contracts` (EN/FR labels, descriptions, offer relevance): `booking_friction`, `unreachable_by_phone`, `slow_or_no_reply`, `website_broken_or_outdated`, `no_online_menu_or_prices`, `hard_to_find_info` (hours/location), `language_barrier`, `payment_friction`, `long_wait_times`, `inconsistent_hours`, `poor_communication`, `positive_strong_reputation` (positive signal), `other`.
- Licensing gate: each provider's licensing profile gets `reviewsUsage: 'none' | 'transient_insights' | 'store_text'`; default **`none`** for Google Places until an owner explicitly enables "derive insights from Google reviews" after a terms acknowledgement dialog (recorded in audit log with the terms URL and date); scraper source follows its own flag; reviews pasted manually by a user (UI textarea "paste reviews") are allowed as `transient_insights`.
- `ReviewSource` port with implementations: `GooglePlacesReviewsSource` (Place Details `reviews` field — verify SKU/cost and terms; only when gate enabled), `ScraperReviewsSource` (from BF-019 payloads when flagged), `ManualPasteSource`.
- `reviews` enrichment step (registered with BF-027): fetch available reviews (transiently), detect language, batch-classify with task `reviews.extract_pain_signals` (fast tier; 20 reviews per call; output: per review `{ tags[], sentiment (-1..1), mentionsOwnerResponse? }`), aggregate into `review_insights`:
  - table `review_insights`: `business_id`, `computed_at`, `sources` text[], `sample_size`, `pain_counts` jsonb (tag → count), `pain_share` jsonb (tag → share), `sentiment_avg`, `owner_response_rate`, `rating_snapshot` (`avg`, `count`, `observedAt`), `rating_trend` (`up|flat|down|unknown`, from snapshots over time where retention allows), `evidence` jsonb (tag → up to 3 **paraphrased** snippets ≤ 20 words, language, sourceRef, `expires_at` per licensing), `model`, `prompt_version`.
  - When `reviewsUsage = transient_insights`, raw review texts are discarded after classification (never persisted); `business_reviews` rows only when `store_text` is allowed (and still no reviewer identity).
- Rating snapshots: store `rating_avg`/`rating_count` observations over time in `business_rating_observations` (`business_id`, `source`, `avg`, `count`, `observed_at`, `expires_at`) within provider retention rules to compute trends.
- Outreach usage policy (documented + enforced in BF-051): emails refer to **aggregated** insights ("several customers mention difficulty booking by phone"), never quote reviews verbatim or identify reviewers.
- UI: business detail **Reviews** tab (registry): pain signals bar chart (counts/shares, EN/FR labels), sentiment, owner response rate, rating trend, evidence snippets (when allowed) with source badge and expiry note; settings: review sources & gates; "Paste reviews" dialog for manual analysis.
- Eval set `reviews.extract_pain_signals` (≥ 120 synthetic reviews EN/FR with labeled tags; include sarcasm, mixed sentiment, short reviews, Creole/French mix) — thresholds: macro-F1 ≥ 0.80 on pain tags, sentiment MAE ≤ 0.25.

**Out of scope**
- Using signals in scoring (→ BF-031) or outreach (→ BF-051). Responding to reviews.

## Requirements
### Functional
- With gates off, the step skips with reason `licensing_disabled` and stores nothing from that source.
- No reviewer names/handles/avatars stored or sent to LLMs (strip before classification).
### Non-functional
- Cost: batched classification; cache by review hash; tracked under `reviews.*` tasks.

## Design
- Patterns: Strategy (`ReviewSource`), Gatekeeper/Policy (licensing check), Aggregator (insights builder as a pure function).

## Implementation plan
1. Contracts (taxonomy, insights DTO, licensing flag).
2. Licensing gate + acknowledgement flow (audit log).
3. Sources (Google gated, scraper, manual paste) with fixtures.
4. LLM task + prompt + eval dataset; iterate to thresholds.
5. Aggregation + persistence + step registration.
6. UI tab + settings + paste dialog.

## Testing
- Unit: aggregation math, trend detection, snippet paraphrase length limits, PII stripping (names, @handles, emails, phones removed before LLM).
- Integration: step with gates off (skip), on with transient insights (no raw text persisted — assert tables), manual paste flow; expiry purge of evidence via retention job hook.
- Eval report attached.

## Acceptance criteria
- [x] Licensing gates per source with owner acknowledgement for Google reviews (default off).
- [x] Reviews step produces aggregated insights with paraphrased evidence; raw text not persisted unless allowed.
- [x] Reviews tab, settings and manual paste work (EN/FR).
- [ ] Eval thresholds met. *(Met on simulated replay answers only — no model key was available; a recorded run is pending, see notes.)*

## Implementation notes

- **Module**: `apps/api/src/modules/reviews` (new bounded context; registers the `reviews` step with the BF-027
  registry and a nightly maintenance task). Domain is pure: personal-details stripping, language, aggregator
  (per-source *contributions* → insights), rating trend, licensing gate policy.
- **Licensing gates** (`REVIEW_SOURCE_LICENSING`, `ProviderLicensing.reviewsUsage`): Google — off by default; enabled
  only by a workspace owner's acknowledgement of a versioned warning (audit log `reviews.google_terms_acknowledged`
  with terms URL and last-modified date) plus a Places key; capped at `transient_insights`, 30-day expiry. Scraper —
  workspace opt-in (`review_source_settings`) *and* BF-019's three gates; reviews are read on demand by a single-place
  scraper job (the step defers while it runs); the job is deleted from the scraper once read. Pasted reviews — always
  `transient_insights`. Turning a source off forgets its insights and cached verdicts. No source allows `store_text`,
  so `business_reviews` is never written.
- **Google terms** (re-read 2026-10-16): GMP Terms §3.2.3 (last modified 2026-08-26) — "(a)(iii) copy and save …
  user reviews" and "(c) No Creating Content From Google Maps Content" — hence default-off, owner acknowledgement,
  no stored text, 30-day expiry, and no Google content in evals (§3.2.3(c)(vii)). Place Details `reviews` is the
  Enterprise + Atmosphere SKU: $25 per 1,000 (first tier), 1,000 free per month, at most 5 reviews (relevance order).
- **Privacy**: reviews are anonymized in memory (source-given author names, names after a title or thank-you,
  e-mails, phones ≥ 8 digits, handles, links → placeholders) before the model; paraphrases are re-anonymized and
  refused when longer than 20 words or quoting ≥ 5 consecutive words (or a short review whole). Stored: counts,
  sentiment sums, owner replies, ≤ 3 paraphrases per tag, each expiring with its source.
- **Classifier**: `reviews.extract_pain_signals` (fast tier, 20 reviews per call, untrusted-data wrapping, injection
  warnings). No gateway response cache (it would keep raw answers); validated per-review verdicts are cached in
  Valkey per workspace and source (30 days).
- **Eval**: 29 batches / 184 synthetic EN/FR/Creole reviews (sarcasm, mixed, short, owner replies, 3 injection
  attempts). Thresholds: tags macro-F1 ≥ 0.80, sentiment MAE ≤ 0.25 (new dataset-level `aggregates` and
  `maxThresholds` in the eval harness). Replay answers are **simulated** (macro-F1 0.922, MAE 0.104): a real run
  (`pnpm eval --task reviews.extract_pain_signals --record`) is needed before trusting the thresholds.
- **Engine additions**: `EnrichmentStep.refreshableFor(org)` (the nightly refresh leaves out steps that could only
  skip — reviews with no fetching source); `NightlyMaintenance` retention hooks; `EnrichmentModule`/`DiscoveryModule`
  memoize their definitions per mode (imported by `reviews`).
- **Concurrency**: merges lock `(workspace, business)` (advisory, transaction-scoped) and hold the source's lock
  shared while re-checking the gate; forgetting a source holds it exclusively.
- **Rating trend**: `business_rating_observations` (with expiry): a review source's rating summary belongs to the
  workspace that fetched it (migration 0022), the golden record's is shared (30 days, as its provenance is usually
  Google); trend from one source's series spanning ≥ 14 days, ±0.1★; only sources the workspace currently uses count.
- **Scraper jobs** hold review text and names on the scraper's disk: every job is tracked (Valkey sorted set) until the
  scraper confirms its deletion, and a nightly sweep deletes stragglers (cancelled runs, deferral caps, outages).
- **Decisions**: insights per `(organization_id, business_id)` (the ticket lists `business_id` only: gates and pasted
  reviews are per workspace); a new paste replaces the previous one; `estimateCost` is an upper bound including the
  paid Google call; owner reply rate is "at least" (source flag, else the review mentions a reply).
- **Tests**: test Valkey container now has 64 databases (each worker suite needs its own); the reviews int suite uses
  DB 16 and one clock shared by app and worker.

## Agent prompt
```text
Implement BF-029 (Review mining and pain signals).

Read first: AGENTS.md, docs/adr/0013, docs/conventions/security.md §6–§7, docs/conventions/ai-engineering.md,
docs/DOMAIN.md (Pain signal). Reuse: enrichment framework (BF-027), @bf/ai (BF-013), audit log (BF-011),
provider licensing profiles (BF-018/BF-019).

Rules:
- Read the current Google Maps Platform terms for review content before implementing the Google source; keep it
  default-off behind an owner acknowledgement.
- Strip personal identifiers before sending text to any model; never store reviewer identities.
- Evidence snippets are short paraphrases, not quotes.

Verify: pnpm verify && pnpm test:int; pnpm eval --task reviews.extract_pain_signals (report in PR).
```

## References
- ADR-0013 · docs/conventions/security.md §7 · docs/conventions/ai-engineering.md
- Google Places API policies: https://developers.google.com/maps/documentation/places/web-service/policies
