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
- [ ] Score/tier visible in listing (column, filter, facet, sort) and pipeline.
- [ ] Scores tab with explanation waterfall and EN/FR reasons.
- [ ] Profile editor with live preview, versioning, activation (bulk recompute progress) and comparison.
- [ ] Permissions enforced; E2E passes.

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
