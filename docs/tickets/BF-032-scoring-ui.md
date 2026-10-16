---
id: BF-032
title: Scoring UI (score badges, explanations, profile editor with live preview)
milestone: M2 Understand
epic: scoring
type: feature
priority: P1
size: M
depends_on: [BF-023, BF-024, BF-031]
blocks: [BF-059]
areas: [web, ui]
---

# BF-032 — Scoring UI (score badges, explanations, profile editor with live preview)

## Context
Scores are only useful if the partner trusts them. The UI must show **why** a business scored high (contributions and plain-language reasons), let the operator tune profiles safely (live preview before saving, versioning, comparison), and surface tiers everywhere in the listing and pipeline. The engine and APIs exist (BF-031); listing and detail page registries exist (BF-023, BF-024).

## Goal
Score badges and tier filters across the app, a Scores tab with an explanation waterfall, and a profile editor with live re-ranking preview, versioning, activation and version comparison.

## Scope
**In scope**
- Listing (BF-023): score column (badge with tier color + number + offer icon), tier facet/filter, primary profile selector (switches the denormalized profile for the workspace — `settings:manage` — or a per-user "view as profile" that sorts client-side via the scores API for the current page), sort by score.
- Pipeline cards (BF-024): tier badge.
- Business detail **Scores** tab (registry): per-profile cards (score, tier, computed time, profile version), waterfall chart of contributions (Recharts), top reasons (EN/FR), feature snapshot table (value + transform + contribution, tooltips with feature descriptions), gated notice, "Recompute" button.
- Settings → **Scoring**:
  - Profiles list (built-in read-only + workspace profiles), duplicate built-in, rename, archive.
  - Editor for a draft version: weights (sliders + numeric inputs, normalized display), transforms (form per transform type with a small chart preview), gates (visual rule builder over features with operators), tier thresholds, reason templates (EN/FR with placeholder validation).
  - **Live preview**: sample of up to 200 businesses from the workspace (stratified by current tier) scored via `POST /v1/scoring/explain` in batches; shows tier distribution histogram (current vs draft), top movers list (biggest rank changes) with links, and Spearman rank correlation vs active version.
  - Save as new version (immutable), activate (triggers bulk recompute with progress via realtime), compare any two versions (tier movement matrix 4×4 incl. X, rank correlation).
- Permission gating (`scoring:manage` for editing/activation; others read-only).
- i18n EN/FR; accessible charts (data tables as alternatives).

**Out of scope**
- Model-based profiles UI (→ BF-059 adds a model selector and shadow comparison).

## Requirements
### Functional
- Editing a draft never affects stored scores until activation.
- Preview reflects the engine exactly (server-side explain; no client re-implementation).
### Non-functional
- Preview of 200 businesses < 3 s; editor responsive (debounced preview).

## Design
```
apps/web/src/features/scoring/{score-badge.tsx, tier-facet.tsx, scores-tab.tsx, waterfall.tsx,
  editor/{weights.tsx, transforms.tsx, gates-builder.tsx, tiers.tsx, reasons.tsx, preview/*}, compare.tsx}
apps/web/src/app/(dashboard)/settings/scoring/{page.tsx, [profileId]/page.tsx}
```

## Implementation plan
1. Badges/columns/facets in listing + pipeline.
2. Scores tab with waterfall and reasons.
3. Profile list + editor forms (react-hook-form + Zod schema from contracts).
4. Live preview (batched explain calls, stats computation for histogram/correlation in a web worker if heavy).
5. Versioning, activation with recompute progress, comparison view.
6. E2E tests.

## Testing
- Component: waterfall renders contributions sum to score; gates builder produces valid DSL; reason template placeholder validation.
- E2E: duplicate built-in profile → change a weight → preview shows movement → save version → activate → listing order changes after recompute completes (realtime).

## Acceptance criteria
- [x] Score/tier visible in listing (column, filter, facet, sort) and pipeline.
- [x] Scores tab with explanation waterfall and EN/FR reasons.
- [x] Profile editor with live preview, versioning, activation (bulk recompute progress) and comparison.
- [x] Permissions enforced; E2E passes.

## Agent prompt
```text
Implement BF-032 (Scoring UI).

Read first: AGENTS.md, docs/PRD.md (J2), docs/conventions/coding-standards.md §3. Reuse: scoring APIs (BF-031),
listing/pipeline registries (BF-023/BF-024), realtime (BF-012), @bf/ui DataTable and form kit (BF-007).

Rules:
- Never re-implement scoring math in the browser; the preview uses the explain endpoint.
- Explanations must read naturally for a non-technical user in EN and FR.
- Charts must have accessible table alternatives.

Verify: pnpm verify && pnpm e2e; screenshots of the Scores tab and editor preview (EN/FR).
```

## References
- docs/PRD.md J2 · BF-031 · Recharts: https://recharts.org/

## Implementation notes
Built in two stacked PRs: part 1 (#95) the profile APIs, score badges and the Scores tab; part 2 the Settings →
Scoring pages, the editor, the live preview, version comparison and the listing's profile selector.

- **API** (scoring module): workspace profiles created from a profile the workspace sees, renamed, archived (no
  longer scored, never primary), immutable versions, activation through the outbox (the workspace recomputes with
  realtime progress); the editor's preview sample (≤ 200, round-robin by tier) and batch explain (≤ 50 per call, the
  engine itself, nothing stored); per-business recompute. Caps (`SCORING_MAX_WORKSPACE_PROFILES`,
  `SCORING_MAX_PROFILE_VERSIONS`) and per-user throttles on every write and on the preview's reads.
- **Web**: `ScoreBadge` (tier colour, score, offer icon) in the listing and on pipeline cards; Scores tab with a
  waterfall (Recharts 3.10.1) that always ends on the score (an adjustment step for the 0–100 bounds or a gate) and a
  contributions table as its accessible alternative; Settings → Scoring (profiles list, duplicate, rename, archive,
  make primary) and the editor (weights with sliders and shares, transforms with a small curve, a gates builder over
  the DSL, tier thresholds, EN/FR reason templates checked for placeholders), the live preview (tier histogram with
  its table, Spearman correlation with the current scores, top movers) and version comparison (4×4 tier movement
  matrix with X, rank correlation). The listing's toolbar switches the workspace's primary profile.
- **Deviations**: the editor keeps its draft in component state validated by `ScoringProfileConfigSchema` instead of
  react-hook-form (the draft is a nested, dynamic structure the schema already checks, problems shown at their
  paths). Only the workspace-wide primary profile switch is offered (no per-user "view as"). The preview compares
  with the sample's stored (current) scores rather than re-scoring the active version. Histogram and correlation are
  computed in the browser from the server's scores (no web worker: 200 items).
- **Out of scope, kept**: model-based profiles (BF-059).

