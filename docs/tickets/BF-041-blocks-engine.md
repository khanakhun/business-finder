---
id: BF-041
title: Blocks engine — fast in-process LLM site composer (plan → copy → assemble → self-check)
milestone: M3 Build
epic: generation
type: feature
priority: P0
size: L
depends_on: [BF-013, BF-039, BF-040, BF-042]
blocks: [BF-047]
areas: [api, worker, ai]
---

# BF-041 — Blocks engine: fast in-process LLM site composer (plan → copy → assemble → self-check)

## Context
`blocks` is the **default engine** ([ADR-0010](../adr/0010-pluggable-agent-engines-in-sandboxes.md)). It is cheap, fast (target median < 2 minutes) and safe because it runs in-process with structured LLM calls only (no tools, no shell). It must produce consistently good bilingual copy grounded in the fact registry, choose blocks and variants well, and fix its own validation issues before handing off to the quality gates (BF-045). The coding-agent engines (BF-044) are slower, more autonomous alternatives. All engines are compared on the same quality score, so this engine sets the baseline.

Inputs come from the BF-040 workspace (brief, facts, starter spec, catalog, asset candidates). The orchestrator (BF-039) calls `run(ctx, signal)` and consumes `EngineEvent`s. Validators and copy lint come from `@bf/site-schema` and `@bf/sitekit` (BF-033, BF-042).

## Goal
An `AgentEngine` implementation (`id: 'blocks'`) that:
- plans pages and blocks;
- writes native copy per locale with fact citations;
- assembles a SiteSpec through BF-033 operations;
- self-repairs targeted issues (≤ 2 internal loops);
- supports the orchestrator's `repair` mode;
- streams progress, usage and cost events;
- respects the budget and abort signal.

It ships with eval datasets and quality thresholds.

## Scope
**In scope**
- **AI tasks** (prompt registry files, versioned, structured output with Zod):
  1. `site-plan.v1` (smart tier, temperature 0–0.2):
     - Input: brief (positioning, page plan template, selling points, pain points, constraints), facts summary (ids + kinds + short values), catalog summary (block types, variants, when to use), asset candidates summary (ids, roles, tags).
     - Output: pages → ordered blocks `{ type, variant, intent, factIds[], assetRoles[] }`, plus nav labels and a hero concept.
     - Deterministic post-checks: variants exist, limits respected, blocks requiring facts (menu, testimonials, team, prices) only planned when such facts exist, booking block only with a `booking_provider` fact.
  2. `site-copy.v1` (smart tier, temperature ~0.5), **one call per page**, pages in parallel (configurable concurrency, default 3):
     - Writes all locales of the page **natively** in one call: each locale is written for its readers, not translated word for word. FR typography is applied.
     - Output: block text props per locale + `factsUsed` per text unit + SEO title/description per locale.
     - Length targets come from the schema `.meta()` limits and are included in the prompt via the catalog.
     - Shared context (system prompt, catalog, brief, facts) uses provider prompt caching across page calls (verify current AI SDK/Anthropic cache-control options).
  3. `site-theme.v1` (fast tier, optional): picks a font pair and accent among curated options given the design direction. The palette itself is computed deterministically from the brand-colour seed with a contrast fix (BF-033 contrast utils).
- **Assembly**: start from the starter `site.json` and apply the plan and copy using BF-033 operations (`setTheme`, `addPage`/`removePage`, `addBlock`/`setBlockVariant`/`updateBlockProps`, `assignAsset`, `setNavigation`). Every operation validates, so assembly bugs surface immediately with precise paths.
- **Asset assignment**: deterministic, by role ranking from BF-038 candidates:
  - hero gets the highest `heroSuitability` with a palette fit; gallery gets diverse images (pHash distance and tag diversity); about gets owner-site images first;
  - focal points are respected;
  - provider-restricted or unlicensed assets are never assigned.
- **Self-check loop** (inside the engine, max 2 iterations, each bounded by the remaining budget):
  - Run `validateSite` + `validateFacts(strict)` + `lintCopy` (BF-042) on the assembled spec.
  - Map issues to blocks/pages.
  - Re-run `site-copy` **only for affected blocks**, passing the issue messages; or apply deterministic fixes for mechanical issues (lengths via a `shorten` micro-task, typography via the formatter, contrast via palette adjustment).
  - Emit `done` only when there are no errors. Warnings are allowed and recorded.
- **Repair mode** (`ctx.mode === 'repair'`): input is the base spec + quality issues from BF-045 (including visual critic findings like "hero text unreadable over image", "sections feel repetitive", "too much text on mobile").
  - The repair planner maps each issue to a strategy:
    | Issue | Strategy |
    |---|---|
    | Unreadable hero text | Swap the hero asset or variant (e.g. `split` instead of `image-background`), or adjust the overlay token |
    | Repetitive sections | Merge or remove blocks, or change variants |
    | Wordy copy | Rewrite the targeted blocks shorter |
  - Applies changes as operations and re-runs the self-check.
- **Copy quality guidelines** (encoded in prompts **and** checked by `lintCopy` from BF-042):
  - concrete and specific (use selling points and facts);
  - no clichés (banned phrase lists per locale, as data);
  - no unverifiable superlatives ("best", "n°1", "leading") unless backed by an award fact;
  - no invented numbers, years, prices, awards, testimonials or team members;
  - neutral wording when facts are missing ("Contactez-nous pour connaître nos horaires");
  - action-oriented CTAs matching available channels (call, WhatsApp, booking, directions);
  - accessible language (sentence length targets).
  - For the Saint-Barthélemy market: refined, calm, upscale tone where the brief says luxury; English that reads naturally for American visitors; French that reads naturally for local and French clients.
- **Events and accounting**:
  - `status` / `progress` (plan 10% → copy per page → assembly → self-check);
  - `log` (human-readable decisions, e.g. "Planned 4 pages: Accueil, Carte, À propos, Contact");
  - `usage` per LLM call (tokens, cost from the BF-013 ledger);
  - `artifact` (`site_spec` uploaded to job artifacts);
  - `done`.

  The engine aborts promptly on `signal` (in-flight requests use the AI SDK abort signal) and on budget exhaustion (`BUDGET_EXCEEDED`, non-retryable for this engine).
- **Registration**: `BlocksEngine` registered in the BF-039 `EngineRegistry`. Capabilities: `sandboxed: false`, `supportsRepair: true`, `supportsChatEdit: true` (BF-047 reuses its copy tasks), `typicalCostUsd` and `typicalDurationSec` measured by evals and updated in config.
- **Evals** (`packages/ai/evals/site-plan`, `site-copy`, `blocks-engine-e2e`):
  - ≥ 24 synthetic businesses across categories (salon, spa, café, restaurant, bakery, hardware, boutique, villa agency, boat charter, gym, dentist, garage), FR/EN and EN-only, with rich and sparse facts.
  - **Automatic metrics:** valid spec rate = 100%; facts violations = 0; lint errors = 0; lint warnings ≤ 3 per site; average cost; P50/P95 duration.
  - **Judged metrics** (agent-tier judge with an anchored rubric, blind to the engine): specificity, tone fit to brief, locale naturalness (FR/EN), structure clarity, CTA quality. Average ≥ 4.0/5, no item < 3.
  - Results stored as an eval report; a regression of more than 0.2 points fails the nightly eval job.

**Out of scope**
- Visual critic and Lighthouse gates (→ BF-045).
- Coding-agent engines (→ BF-044).
- Chat edit UX (→ BF-047, which reuses these tasks).

## Requirements
### Functional
- Output always passes `sitekit validate` (schema + semantic + strict facts) or the engine emits a typed error. It never emits an invalid `done`.
- Sparse-facts businesses get honest, shorter sites (e.g. 2–3 pages) rather than padded ones.
- Repair mode changes only what the issues require (diff limited to affected blocks/pages; test asserts it).
### Non-functional
- Median duration < 2 min, P95 < 4 min for a 4-page FR/EN site; median cost ≤ USD 0.40 (measured by evals and reported).
- Abort within 3 s of the signal.

## Design
```
apps/api/src/modules/generation/infrastructure/engines/blocks/
├── blocks.engine.ts            # AgentEngine impl: orchestrates steps, events, budget, abort
├── steps/{plan.step.ts, theme.step.ts, copy.step.ts, assemble.step.ts, assets.step.ts, self-check.step.ts,
│          repair-planner.ts}
├── mapping/{plan-to-ops.ts, copy-to-ops.ts, issues-to-targets.ts}
└── budget/{cost-guard.ts}
packages/ai/prompts/{site-plan.v1.md, site-copy.v1.md, site-theme.v1.md, copy-shorten.v1.md}
packages/ai/evals/{site-plan, site-copy, blocks-engine-e2e}/*
```
- Patterns:
  - Pipeline / Template Method (engine steps).
  - Strategy (repair strategies per issue type).
  - Command (BF-033 operations for assembly and repair).
  - Guard (cost guard checks the budget before each LLM call using estimates, and after using actual usage).
- Context engineering: prompts include only what each step needs (plan: summaries; copy: per-page plan + referenced facts + relevant catalog entries). Facts are presented as a table with ids. Untrusted context is wrapped and optional (excerpts of the current site to capture the voice). Instructions found there are ignored.

## Implementation plan
1. Prompts v1 + Zod output schemas; a minimal plan step with deterministic post-checks.
2. Copy step per page with locale-native writing and `factsUsed`; prompt caching.
3. Assembly via operations; asset assignment; theme step.
4. Self-check loop with targeted regeneration and deterministic fixers.
5. Repair mode with the issue-to-strategy mapping.
6. Events, budget guard, abort handling; registry wiring (replace FakeEngine as default in non-test environments).
7. Eval datasets, judge rubric, nightly eval job thresholds; tune prompts; report results.

## Testing
- **Unit:** plan post-checks (facts-required blocks), plan/copy to operations mapping, issue to target mapping, cost guard, deterministic fixers (typography, length shortening fallback).
- **Integration** (fake LLM provider with recorded fixtures from BF-013):
  - full run produces a valid spec for 4 fixture businesses;
  - self-check fixes a seeded over-length title;
  - repair mode with a visual-critic issue changes only the hero block;
  - abort mid-copy stops within 3 s;
  - budget exhaustion gives the typed error.
- **Contract:** emitted event sequence conforms to the `EngineEvent` schema and ordering (status → … → artifact → done).
- **Evals:** real-model runs via `pnpm eval` (manual or nightly), report attached to the PR.

## Acceptance criteria
- [ ] `blocks` engine implements `AgentEngine` with plan → theme → copy → assemble → self-check and repair mode.
- [ ] Copy is locale-native, fact-grounded (`factsUsed`), lint-clean and within limits; sparse-facts sites stay honest.
- [ ] Events, cost accounting, budget guard and abort behaviour verified by tests.
- [ ] Eval suites with thresholds; report shows 100% validity, 0 fact violations, judged average ≥ 4.0.
- [ ] Registered as the default engine with measured typical cost and duration.

## Agent prompt
```text
Implement BF-041 (Blocks engine).

Read first: AGENTS.md, docs/conventions/ai-engineering.md (all), docs/adr/0010 and 0011, docs/ARCHITECTURE.md §9
and §11, BF-039 (AgentEngine contract, events, repair mode), BF-040 (workspace: brief, facts, starter spec, assets),
BF-033 (operations/validators/catalog), BF-042 (lintCopy/validate library functions). Skim BF-045 (issues you must
repair) and BF-047 (will reuse your copy tasks).

Rules:
- Structured output only (Zod) through @bf/ai; prompts are versioned files; no inline prompt strings in code.
- Every generated text unit cites factsUsed; never invent facts; neutral copy when facts are missing.
- Assemble via BF-033 operations — never hand-edit JSON blobs.
- Write each locale natively (not translated); respect French typography.
- Respect budget and abort signal at every step; emit EngineEvents faithfully.
- Use evals to tune prompts; report metrics and costs in the PR.

Verify: pnpm verify && pnpm test:int; pnpm eval --filter=@bf/ai -- blocks-engine-e2e (attach report).
```

## References
- ADR-0010 · ADR-0011 · docs/conventions/ai-engineering.md · BF-033/BF-039/BF-040/BF-042
- AI SDK structured output: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data · Anthropic prompt caching: https://docs.claude.com/en/docs/build-with-claude/prompt-caching
