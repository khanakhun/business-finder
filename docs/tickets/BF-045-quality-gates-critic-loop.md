---
id: BF-045
title: Quality gates and critic loop — facts, claims, copy, accessibility, Lighthouse, visual critic, auto-fix, repair
milestone: M3 Build
epic: generation
type: feature
priority: P0
size: L
depends_on: [BF-013, BF-034, BF-039, BF-040, BF-042, BF-043]
blocks: [BF-046, BF-058]
areas: [worker, ai, sites]
---

# BF-045 — Quality gates and critic loop: facts, claims, copy, accessibility, Lighthouse, visual critic, auto-fix, repair

## Context
A preview link sent to a prospect represents the agency, so every generated version must be **correct** (no invented facts), **accessible**, **fast** and **good-looking** before it is published ([PRD FR-45](../PRD.md#65-website-platform--ai-generation)). Engines differ in quality. A shared, explainable quality pipeline makes them comparable and catches failures, and the repair loop gives engines a chance to fix issues ([ARCHITECTURE §11](../ARCHITECTURE.md#11-generation-agents), DOMAIN §3.3: `validating → repairing → validating`, max 2 repairs, otherwise `needs_review`).

BF-039 defines the `QualityPipeline` port and ships a schema-only default. This ticket replaces it with the full chain:
1. schema;
2. facts;
3. unsupported claims;
4. copy;
5. auto-fix;
6. accessibility;
7. performance;
8. visual critic;
9. score and decision.

## Goal
A Chain-of-Responsibility quality pipeline that:
- runs cheap deterministic gates first;
- applies safe auto-fixes as operations;
- runs render-based audits (axe, Lighthouse, screenshots) inside the BF-043 sandbox via a new `sitekit audit` command;
- runs a calibrated vision critic with an anchored rubric;
- aggregates a 0–100 quality score per version;
- returns `pass | repair(issues) | needs_review(issues)` with targeted, repairable issues.

## Scope
**In scope**
- **Issue model** (`@bf/contracts/quality`): `QualityIssue { gate, code, severity (error|warning|info), message, target? { pageId, blockId?, path?, locale? }, evidence?, repairable, suggestedFix?, autoFixable }` and `QualityReport { version, score, decision, gates[{ id, status (pass|fail|skipped|error), score?, durationMs, costUsd, issues[] }], rubric?, screenshots[] }`.
- **Gates**, in order; each is a `QualityGate` (`id`, `appliesTo`, `run(ctx) → GateResult`), registered in a configurable chain:
  1. **SchemaGate**: `sitekit.validate` (schema + semantic). Errors fail and short-circuit.
  2. **FactsGate**: strict facts validation against the **job's registry snapshot** (BF-040), including literal detectors. Errors fail and short-circuit (never auto-fixed: facts must come from the registry).
  3. **ClaimsGate** (AI, `unsupported-claims.v1`, fast tier, structured):
     - Extracts factual claims from all copy per locale (e.g. "family-run since 1985", "award-winning", "only organic products", "5 minutes from the beach") and classifies each as `supported(factIds)`, `generic` (non-factual marketing language) or `unsupported`.
     - Deterministic check: supporting fact ids must exist in the snapshot.
     - Unsupported claims are repairable errors targeted to the block and locale.
     - Eval: ≥ 95% recall on seeded unsupported claims, ≤ 5% false positives on generic language (FR/EN dataset ≥ 60 rows).
  4. **CopyGate**: `sitekit.lintCopy` (errors fail; warnings reduce the score).
  5. **AutoFixer**: applies safe deterministic fixes as BF-033 operations, then re-runs gates 1–4 once:
     - typography and whitespace (lint autofix);
     - palette contrast nudges (BF-033 contrast suggestions);
     - SEO length trimming at word boundaries (only when within 10% over);
     - missing `alt` text filled from asset metadata (BF-038 multilingual alt).

     Each fix is recorded in the report (`autoFixes[]`), and the fixed spec becomes the candidate version.
  6. **AccessibilityGate** (sandboxed): axe-core on every page × locale at mobile and desktop widths via `sitekit audit`. Serious and critical violations fail (repairable when tied to content, e.g. heading order or link text). Moderate violations are warnings.
  7. **PerformanceGate** (sandboxed): Lighthouse (mobile and desktop presets) on home + the heaviest inner page via `sitekit audit`.
     - Thresholds (configuration): performance ≥ 90 (target 95), accessibility ≥ 95, best practices ≥ 95, SEO ≥ 90.
     - Audited with an indexable render variant, or the `is-crawlable` audit excluded, because previews are `noindex` by design.
     - Failures caused by our platform (fonts, CSS, scripts) are tagged `platform` (not repairable by engines; alert the team). Content-caused ones are repairable (e.g. too many gallery images on home, oversized hero choice).
  8. **VisualCriticGate** (AI, `visual-critic.v1`, smart tier with vision; agent tier configurable):
     - Inputs: screenshots (home desktop 1280 px and mobile 390 px at 2×, plus one inner page), the brief's design direction and audience, the block outline (types/variants per page).
     - **Anchored rubric** (1–5 with descriptions for 1, 3 and 5): visual hierarchy, typography, spacing and rhythm, imagery quality and relevance, colour harmony and contrast, CTA clarity, mobile layout, brand and positioning fit (premium/luxury when relevant), originality (not template-generic).
     - Output: per-criterion score + evidence + issues with targets (block ids from the outline) + `suggestedFix` mapped to the BF-041 repair strategies (swap hero asset or variant, reduce text, merge repetitive sections, change density, adjust accent).
     - Pass: weighted average ≥ 3.5 and no criterion ≤ 2 (configuration).
     - Screenshots are re-captured after auto-fixes. Cost is metered.
  9. **Scorer and decision**:
     - Score 0–100 = weighted combination (facts/claims/schema are gates, not weights; weights over copy warnings, a11y, performance and rubric; documented).
     - Decision logic:
       - all gates pass → `pass`;
       - repairable errors, repairs left and the engine supports repair → `repair(issues)`, prioritized and capped at 12 issues so engines stay focused;
       - otherwise → `needs_review(issues)`.
     - `QualityReport` stored on the site version (`site_versions.quality`, set-once per BF-035) and summarized on the job.
- **`sitekit audit`** (extends BF-042; runs inside the BF-043 runner image, which gains Lighthouse and axe-core):
  - `sitekit audit --json [--pages home,…] [--viewports mobile,desktop] [--lighthouse] [--axe] [--screenshots]`.
  - Renders the static site locally, then runs axe (Playwright + `@axe-core/playwright`) and Lighthouse (programmatic, using the bundled Chromium) against 127.0.0.1.
  - Outputs a JSON report + screenshots as artifacts via the runner frames.
  - The worker runs it with a **quality** sandbox profile: no model keys, no egress at all.
- **Pipeline implementation**: `FullQualityPipeline` implements the BF-039 `QualityPipeline` port and replaces the schema-only default via DI.
  - Idempotent per (`siteVersion` candidate hash, pipeline version), with results cached.
  - Timeouts per gate; a gate infrastructure error (not a content failure) is retried once, then the gate is marked `error` → decision `needs_review` with an infra flag (never silently pass).
  - Configuration per workspace: thresholds can be tightened (not loosened below platform minimums); gates can be toggled for the dev environment only.
- **Human review support** (API for BF-046):
  - `GET /v1/generation-jobs/:id/quality` (full report with signed screenshot URLs).
  - `POST /v1/generation-jobs/:id/accept` (`sites:publish`): publish a `needs_review` version anyway; requires a reason and records it, but is **blocked** if facts or schema errors exist.
  - `POST /v1/generation-jobs/:id/repair` (manual repair attempt with an optional engine choice).
- **Calibration**:
  - A golden set of ≥ 30 rendered sites (mix of strong, average and weak; fixtures + generated) with human ratings on the rubric, collected with a small script + JSON file. Ratings come from the team; partners can add more later.
  - Measure critic–human agreement (Spearman ≥ 0.6 on overall; report per criterion).
  - Choose thresholds from the data; document in `docs/quality/visual-rubric.md`.
- **Observability**:
  - Metrics: gate pass rates per engine, repair rate, `needs_review` rate, average score per engine/category, critic cost, Lighthouse distributions.
  - Alert on a spike in `platform`-tagged performance failures.

**Out of scope**
- Generation UI display (→ BF-046), engine-side repair logic (BF-041/BF-044 implement repair mode), analytics dashboards (→ BF-058).

## Requirements
### Functional
- A version with facts or schema errors can never be published by the pipeline or by "accept anyway".
- Every issue sent for repair has a target and an actionable message; non-repairable issues never trigger repair loops.
- The pipeline is deterministic for deterministic gates and records model and prompt versions for AI gates.
### Non-functional
- Full pipeline P95 < 3 min per version (4 pages × 2 locales), of which the sandboxed audit < 90 s.
- Cost of AI gates ≤ USD 0.10 per version on average (measured).

## Design
```
packages/contracts/src/quality/{issue.ts, report.ts, rubric.ts}
apps/api/src/modules/generation/
├── domain/quality/{decision-policy.ts, scorer.ts, issue-prioritizer.ts, thresholds.ts}
├── infrastructure/quality/
│   ├── pipeline/{full-quality.pipeline.ts, chain.ts, cache.ts}
│   ├── gates/{schema.gate.ts, facts.gate.ts, claims.gate.ts, copy.gate.ts, autofix.stage.ts, a11y.gate.ts,
│   │          performance.gate.ts, visual-critic.gate.ts}
│   └── audit/{sandbox-audit.client.ts}
└── interface/http/{quality.controller.ts}
packages/sitekit/src/lib/audit/{audit.ts, axe.ts, lighthouse.ts}
packages/ai/prompts/{unsupported-claims.v1.md, visual-critic.v1.md}
packages/ai/evals/{unsupported-claims, visual-critic}/*
docs/quality/visual-rubric.md
```
- Patterns:
  - Chain of Responsibility (gates).
  - Strategy (decision policy, scorer).
  - Command (auto-fix operations).
  - Specification (thresholds).
  - Cache-aside (results per candidate hash).
  - Calibration-driven thresholds (data over intuition).

## Implementation plan
1. Contracts + decision policy + scorer + prioritizer (TDD).
2. Deterministic gates (schema, facts, copy) + AutoFixer with operations.
3. `sitekit audit` (axe + Lighthouse + screenshots) + runner image update + quality sandbox profile.
4. Accessibility and performance gates via the sandbox audit client.
5. Claims gate (prompt, eval) and visual critic (rubric, prompt, eval); cost metering.
6. Pipeline wiring as the BF-039 port, caching, timeouts and infra-error handling; review APIs.
7. Calibration set, agreement analysis, thresholds doc; metrics and alerts.

## Testing
- **Unit:** decision matrix (all combinations: pass, repair with repairs left, repair without support, `needs_review`, infra errors), scorer weights, issue prioritization and cap, threshold tightening rules.
- **Integration** (fake LLM provider + Docker for the audit):
  - fixture site passes;
  - seeded unsupported claim → repair issue targeted to the block;
  - seeded contrast issue auto-fixed;
  - seeded heading-order a11y violation → repairable error;
  - Lighthouse platform regression (inject a heavy script into the render variant in test mode) → `platform` tag, no repair loop;
  - "accept anyway" blocked with facts errors and allowed with only critic issues;
  - pipeline idempotent on a re-run.
- **End-to-end** with BF-039 + BF-041: generation with an injected weak hero → critic issue → repair attempt → pass.
- **Evals:** claims recall/precision; critic agreement on the golden set (report attached).

## Acceptance criteria
- [x] Full gate chain implemented as the BF-039 `QualityPipeline` with auto-fix, caching and infra-error safety.
- [x] `sitekit audit` (axe + Lighthouse + screenshots) runs in a no-egress sandbox profile. (Screenshots for the critic come with part 3.)
- [ ] Claims gate and visual critic with anchored rubric, evals and calibration (agreement report, thresholds documented).
- [x] Quality report stored per version; decisions drive repair (≤ 2) or `needs_review`; review APIs with safe "accept anyway".
- [x] Metrics and alerts for gate outcomes, costs and platform regressions.

## Agent prompt
```text
Implement BF-045 (Quality gates and critic loop).

Read first: AGENTS.md, docs/conventions/ai-engineering.md (§5, §8 vision rubrics, §9 evals), docs/ARCHITECTURE.md §11,
docs/DOMAIN.md §3.3, BF-039 (QualityPipeline port, repair transitions), BF-040 (registry snapshots), BF-041/BF-044
(repair strategies the engines understand), BF-042 (sitekit), BF-043 (sandbox profiles), BF-034 (static renderer).

Rules:
- Cheap deterministic gates first; facts/schema errors are never auto-fixed and never publishable.
- Every repair issue has a target and an actionable fix; separate platform problems from content problems.
- Render-based audits run in the sandbox with no egress; never in the API process.
- AI gates use versioned prompts, structured outputs, anchored rubrics and evals; calibrate thresholds with data.
- Never silently pass on infrastructure errors.

Verify: pnpm verify && pnpm test:int; evals for claims and critic (attach reports and the calibration summary).
```

## References
- docs/ARCHITECTURE.md §11 · docs/DOMAIN.md §3.3 · docs/conventions/ai-engineering.md §8–§9
- axe-core Playwright: https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright · Lighthouse (programmatic usage): https://github.com/GoogleChrome/lighthouse/blob/main/docs/readme.md#using-programmatically · WCAG 2.2: https://www.w3.org/TR/WCAG22/
