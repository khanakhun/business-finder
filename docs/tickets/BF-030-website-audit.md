---
id: BF-030
title: Website audit (PageSpeed, vision grade, findings, website status)
milestone: M2 Understand
epic: enrichment
type: feature
priority: P0
size: L
depends_on: [BF-013, BF-026, BF-027]
blocks: [BF-031, BF-040, BF-051]
areas: [api, worker, ai, web]
---

# BF-030 — Website audit (PageSpeed, vision grade, findings, website status)

## Context
"Is this website weak?" is the core question for redesign offers, and its answer must be **explainable** (shown to the partner and used in outreach). Inputs: site intel snapshots and screenshots (BF-026/BF-027), Google PageSpeed Insights API (free key, 25,000 requests/day, 240/min per project — verify current quota), and a vision model grading screenshots with an anchored rubric ([ai-engineering.md §8](../conventions/ai-engineering.md#8-vision-tasks)). The listing filter `website=weak` (hook from BF-022) needs a stored `website_status`.

## Goal
Two enrichment steps (`psi`, `vision_audit`) and a deterministic findings engine produce a `WebsiteAudit` per snapshot: PageSpeed scores/metrics, a rubric-based visual grade with evidence, prioritized findings with i18n texts and offer relevance, an overall quality score, and a `website_status` used across search, scoring and outreach — shown in a polished Website tab.

## Scope
**In scope**
- Table `website_audits`: `id`, `business_id`, `snapshot_id`, `psi` jsonb (`mobile`/`desktop`: category scores (performance, accessibility, best-practices, seo), metrics (LCP, CLS, INP or TBT, FCP, Speed Index, TTFB), top opportunities with savings, lighthouseVersion, fetchedAt), `vision` jsonb (criteria scores 1–10 with evidence, overall, summary EN/FR, model, promptVersion), `findings` jsonb[] (`code`, `severity` critical|major|minor|info, `evidence`, `metric?`, `offerRelevance[]`), `quality_score` smallint 0–100, `website_status` (`none|parked|social_only|broken|weak|ok|strong`), `created_at`; latest-audit view per business.
- `psi` step: PSI API v5 (`runPagespeed`) with key from secrets (`pagespeed_api_key`, global fallback), both strategies, categories all four; token-bucket per key (respect per-minute and daily quotas), retries on 429/5xx; store compact results (not full Lighthouse JSON — optionally the full report to object storage).
- `vision_audit` step (depends on `site_intel` screenshots): task `website.vision_grade` (smart tier vision) with rubric criteria: `modernity`, `visual_hierarchy`, `mobile_usability`, `readability`, `imagery_quality`, `trust_signals`, `cta_clarity`, `brand_consistency`, each with anchored scale descriptions and required evidence; screenshots resized (desktop 1280 w, mobile 390 w @2x) before sending; summary in EN and FR.
- Findings engine (deterministic rules registry; each rule = `code`, condition over snapshot/PSI/vision/category, severity, i18n keys for title/explanation/recommendation, offer relevance):
  - Presence: no website, parked domain, social-only presence, broken site (5xx/timeout/TLS error).
  - Security: no HTTPS, certificate expiring < 14 days, mixed content.
  - Mobile: missing viewport meta, low mobile vision score.
  - Performance: mobile LCP > 4 s, CLS > 0.25, performance score < 50, page weight > 4 MB.
  - Conversion: no visible phone/email, no contact form, appointment-based category without online booking, restaurant without online menu, tourism-facing business in BL without English version (or FR site without EN / EN without FR).
  - Freshness: copyright year older than 2 years, outdated tech (e.g. jQuery < 3, old WordPress major — versions from fingerprints).
  - Accessibility: accessibility score < 70.
  - Compliance-adjacent: no-solicitation statement present (info severity; informs compliance BF-049).
- Quality score: weighted composite (PSI performance & accessibility, vision overall, findings penalties) — formula documented and unit-tested; `website_status` derived by rules (`strong` ≥ 80, `ok` 60–79, `weak` < 60, plus presence statuses).
- Implement the `website=weak` search filter hook (BF-022) using the latest audit's status.
- Website tab (extends BF-027's tab): quality gauge, status badge, PSI cards (mobile/desktop, metrics with good/needs-improvement/poor thresholds), vision criteria radar or bar list with evidence, findings grouped by severity with recommendations (EN/FR), screenshots side by side, "Re-run audit".
- Fixture-based eval for vision grading: synthetic fixture sites (good/average/poor designs created for tests, no third-party content) rendered by the intel test server → screenshots → expected score bands; thresholds: ≥ 85% within band; pairwise ordering accuracy ≥ 90% (good > average > poor).

**Out of scope**
- Scoring profiles (→ BF-031). Using findings in emails (→ BF-051) and briefs (→ BF-040).

## Requirements
### Functional
- `website_status` and `quality_score` available for every audited business; filter `website=weak` works.
- Findings are reproducible from stored inputs (rules are pure).
### Non-functional
- PSI quota respected under bulk runs (token bucket); vision cost tracked per audit.

## Design
- Patterns: Rules Engine / Specification (findings), Strategy (scoring formula), Plugin steps (enrichment registry).

## Implementation plan
1. Contracts (audit DTO, findings registry with i18n keys).
2. PSI client + step (fixtures for PSI responses).
3. Vision task + prompt + rubric + eval fixtures + step.
4. Findings rules + quality score + status (unit tests per rule).
5. Persistence + latest-audit view + search hook.
6. Website tab UI (EN/FR).

## Testing
- Unit: each findings rule (positive/negative cases), quality score formula, status derivation, PSI response mapping.
- Integration: steps registered and executed in order; audit stored; search filter returns weak sites.
- Eval: vision grading report attached.
- E2E: Website tab shows audit for a seeded business.

## Acceptance criteria
- [x] `psi` and `vision_audit` steps registered; audits stored with PSI, vision, findings, quality score and status.
- [x] Findings registry with ≥ 20 rules and EN/FR texts.
- [x] `website=weak` filter works in listing search.
- [x] Website tab displays the full audit.
- [ ] Vision eval meets thresholds. *(Met on simulated replay answers only — no model key; a recorded run is pending.)*

## Implementation notes

- **Steps** (`enrichment/infrastructure/steps/website-audit.steps.ts`): `psi` (depends on `site_intel`) and
  `vision_audit` (depends on `site_intel`, optionally on `psi`). Both write their part of the snapshot's audit through
  `WebsiteAuditService` (advisory lock per business; a part that could not be measured keeps an earlier measurement
  of the same snapshot, per PageSpeed strategy) and recompute findings, score and status. The latest audit is the
  one of the business's newest crawl, whatever order snapshots are written in. Outages and quotas: the part is left
  out and the step asks for a re-check within the hour (never rethrown); configuration errors (refused key, no model
  key) fail the step. Unreachable, parked and social-only sites get a presence-only audit without calling anything.
  A site that blocks our crawler is measured by PageSpeed only (Lighthouse often gets through; its screenshots show
  the block page, so no vision grade).
- **DECISION — no website**: `none` is never stored (no crawl, no audit). `GET /v1/businesses/:id/website-audit`
  returns `status: 'none'` for a business without a website, so scoring (BF-031) and outreach read one field.
- **PageSpeed** (verified 2026-10-16): `GET pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed` with
  `strategy` MOBILE|DESKTOP and `category` PERFORMANCE, ACCESSIBILITY, BEST_PRACTICES, SEO; the key travels in the
  documented `key` query parameter (span URLs are redacted). Default quota per third-party sources: 25,000/day and
  400/100 s — configurable (`PAGESPEED_RATE_PER_MINUTE` 200, `PAGESPEED_DAILY_QUOTA` 24,000), enforced by per-key
  token buckets in Valkey (both runs taken at once, all or none; a step waiting for the minute bucket backs off from
  1 s to a minute with jitter, about 10 minutes in all, then is re-checked later). Lighthouse's own failures
  ("Lighthouse returned error", 400 or 500) belong to the site: never retried nor counted by the shared breaker.
  Only a compact result is stored (DECISION: no full Lighthouse report in object storage).
- **Vision**: `website.vision_grade` (smart tier, 8 anchored criteria with evidence, EN/FR summary), screenshots
  resized to ≤ 1,700 px (mobile 390 px at 2×), only this business's artifacts; no response cache (the gateway never caches a call
  with images). A failed paid call (invalid output) still books its cost on the run.
- **Findings**: 28 rules (≥ 20 required), registry and EN/FR texts in `@bf/contracts` (`FINDING_DEFINITIONS`) for the
  web, outreach (BF-051) and briefs (BF-040). Category facts: the primary category's attributes inherited from its
  ancestors; menus matter for `food_drink`. Site languages come from the text and hreflang (a theme's declared
  `lang` only when nothing was detected).
- **Quality score**: weighted mean of vision overall ×10 (0.40), mobile performance (0.25), accessibility (0.15), SEO
  (0.10), best practices (0.10) — renormalized over what was measured, desktop standing in for missing mobile — minus
  penalties critical 15 / major 6 / minor 2, capped at 40; null when nothing was measured. Status: presence first,
  then strong ≥ 80, ok 60–79, weak < 60; unmeasured readable sites are weak with a critical or two major findings.
- **Search**: `website=weak` matches the latest audit's `weak` or `broken` (DECISION: a broken site is weak too).
- **DECISION — "latest-audit view"** is an `is_latest` flag with a partial index (maintained on write) instead of a
  SQL view: search and scoring read it with an index lookup.
- **Eval**: 15 synthetic sites (5 good, 5 average, 5 poor; fictional, inline CSS, no third-party content) rendered to
  30 screenshots; replay answers are **simulated** (within band 0.867, pairwise 0.973) — run
  `pnpm eval --task website.vision_grade --record` with a key.
- **Tests**: `StepRegistry.replace` lets the engine suite script `psi`/`vision_audit` (no unregistered id is left);
  the audit suite uses Valkey DB 17 and one clock shared by app and worker. E2E servers run `FAKE_WEBSITE_AUDIT`.
- **Also fixed here**: a realtime stream refused at first (429: five streams per user, hit by parallel E2E workers)
  refetches everything once it opens (missed events cannot be replayed); an already-cancelled caller never takes the
  breaker's half-open trial (BF-029 follow-up).

## Agent prompt
```text
Implement BF-030 (Website audit: PageSpeed, vision grade, findings, website status).

Read first: AGENTS.md, docs/conventions/ai-engineering.md (§8 vision, §9 evals), docs/ARCHITECTURE.md §8 (F3),
docs/PRD.md (J2). Reuse: snapshots + screenshots (BF-026/BF-027), @bf/ai vision + evals (BF-013), search hook (BF-022),
detail tab registry (BF-024).

Rules:
- Verify the current PageSpeed Insights API v5 request/response and quotas before coding.
- Findings are deterministic, pure and individually tested; the model only grades visuals with evidence.
- Synthetic fixture sites only (no screenshots of real businesses in the public repo).

Verify: pnpm verify && pnpm test:int && pnpm e2e; pnpm eval --task website.vision_grade (report in PR).
```

## References
- PageSpeed Insights API: https://developers.google.com/speed/docs/insights/v5/get-started · Web Vitals thresholds: https://web.dev/articles/vitals
- docs/conventions/ai-engineering.md §8–§9
