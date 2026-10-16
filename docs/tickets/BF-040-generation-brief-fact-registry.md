---
id: BF-040
title: Generation brief, verified fact registry and agent workspace builder
milestone: M3 Build
epic: generation
type: feature
priority: P0
size: L
depends_on: [BF-013, BF-015, BF-026, BF-029, BF-030, BF-033, BF-038, BF-039]
blocks: [BF-041, BF-044, BF-045, BF-046, BF-047, BF-051, BF-057]
areas: [api, worker, ai, contracts]
---

# BF-040 — Generation brief, verified fact registry and agent workspace builder

## Context
Engines generate good sites from good inputs. The biggest risk in AI-generated sites for real businesses is **invented facts**: fake prices, testimonials or awards, and wrong opening hours or phone numbers. Our rule is that prospect-facing content may only state facts in the **fact registry** ([ai-engineering §5](../conventions/ai-engineering.md#5-grounding-and-the-fact-registry)). The registry must also respect data licensing: content whose only source is a restricted provider (e.g. Google Places) must not be printed on a generated site ([ADR-0013](../adr/0013-discovery-providers-and-data-licensing.md)).

This ticket implements the `WorkspacePreparer` port defined by BF-039. It assembles:
- a verified fact registry snapshot;
- a structured, explainable **brief** (positioning, page plan, design direction, selling points, constraints);
- a starter `SiteSpec`;
- a deterministic **workspace bundle** that every engine receives (blocks, Claude Agent SDK, Claude Code, Codex).

## Goal
Every generation job starts from a reproducible workspace containing:
- `BRIEF.md` / `brief.json`;
- `facts.json` (display-safe facts only, with provenance);
- `business.json`, `site.json` (valid starter);
- the block catalog and JSON Schema;
- `AGENTS.md` site-agent rules;
- licensed asset candidates;
- clearly delimited untrusted context.

All of it is built from evidence-verified extraction, with brief preview and override APIs for the UI.

## Scope
**In scope**
- **Fact model** (extends the `FactRegistry` type from BF-033 in `@bf/contracts/facts`):
  - Kinds (typed values via a Zod discriminated union):
    - `name`, `tagline`, `about_summary`;
    - `address`, `geo`, `phone`, `email`, `whatsapp`, `website`, `social`, `hours`;
    - `service`, `price` (amount, currency, unit, service ref), `menu_section`, `menu_item`;
    - `testimonial` (quote, attribution as published, source page);
    - `team_member` (name + role as published);
    - `year_founded`, `award`, `language_spoken`, `amenity`, `payment_method`, `booking_provider` (URL + provider);
    - `area_served`, `category`, `brand_color`, `logo`.
  - Fact fields:
    - `id`: stable, `fact_<kind>_<hash(normalizedValue, sourceRef)>`;
    - `value`, `locale?`;
    - `source` (`owner_site|jsonld|open_data|golden_record|user|provider_restricted`), `sourceRef` (URL, field or user id);
    - `evidence?` (quote ≤ 25 words);
    - `confidence`, `observedAt`;
    - `usage` (`display|internal`).
  - **Usage rules** (Specification): a fact is `display` only if at least one provenance is licensed for display: owner site, its JSON-LD, open data with compatible license (Overture, OSM, Foursquare OS Places, with attribution recorded), or user-asserted. Facts sourced only from restricted providers are `internal`; they may guide internal reasoning (e.g. category) but are never written to `facts.json`.
  - **Testimonials** come only from testimonials the business published on its own site (with attribution as published). Third-party platform reviews are never testimonial facts. Review mining (BF-029) feeds *themes* into the brief, not quotes.
- **Owner-site fact extraction** (`extract-site-facts.v1` AI task, smart tier, structured output):
  - Input: BF-026 page markdown (home, about, services, menu, contact, booking pages), wrapped as `<untrusted_data>` and truncated to budgets.
  - Output: candidates with `evidence` quotes + page URL.
  - **Deterministic verification**: the evidence quote must fuzzy-match the page text (token-set ratio ≥ 0.9 after normalization). Every number, price, phone, email or year in the value must appear verbatim (normalized) in the evidence. Candidates that fail are dropped and counted (metrics), never stored.
  - Prices normalized (currency detection €/$/USD/EUR; St Barth commonly uses € and $). Hours normalized to the weekly spec. FR/EN texts keep their locale.
- **User-asserted facts** (org overlay; the global graph stays clean):
  - Table `org_business_facts` (`id`, `organization_id`, `business_id`, `kind`, `value`, `locale?`, `note`, `created_by`, timestamps, `deleted_at`).
  - API `GET/POST/PATCH/DELETE /v1/businesses/:id/facts` (permission `business:write`).
  - The registry merges global facts with the org overlay; overlay wins on conflict, with both kept in provenance. Used by the editor's FactPicker (BF-037) and chat edit (BF-047).
- **Registry snapshots**: table `fact_registry_snapshots` (`id`, `organization_id`, `business_id`, `content_hash`, `facts` jsonb, `stats` jsonb, `created_at`). Each generation job references the snapshot id, so validation and later audits use the same facts. Snapshots are deduplicated by hash.
- **Brief** (`GenerationBrief`, Zod, versioned `briefVersion: 1`):
  - **Identity**: name, category path (taxonomy), locality/area (area pack), short description from facts.
  - **Offer** being pitched (`new_website|website_redesign|…`) and what improves vs the current site, from audit findings (BF-030). Used for messaging focus; never printed as claims about the business.
  - **Audience and positioning hints**: market (luxury tourism vs residents), deduced from category + area pack + review themes; each hint lists its evidence ids.
  - **Locales**: from org settings + area pack (BL default `fr,en`) + languages detected on the current site. Default locale chosen by the business's existing primary language.
  - **Page plan**: data-driven templates per taxonomy prefix (most specific match wins), stored in `page-plans/*.yaml`.
    - Examples: café/restaurant → Home, Menu (only if menu facts exist, else a "Our café" section), About, Contact. Salon/spa → Home, Services (prices only if price facts), About, Contact. Hardware/retail → Home, Products & services, About, Contact. Villa rental agency → Home, Services, About, Contact (+ booking CTA if a booking provider fact exists).
    - Each page lists recommended blocks with variants, in order. Pages without enough facts collapse into sections of other pages, never into filler.
  - **Selling points**: ≤ 6, each referencing fact ids or review-theme ids (e.g. "renowned for brunch" ← review theme with ≥ N mentions).
  - **Pain points to solve** with the site: e.g. `booking_friction` → prominent booking or WhatsApp CTA; `unreachable_by_phone` → WhatsApp + email channels.
  - **Design direction**: style family suggestion with reasons, palette seed (brand colours from logo/site CSS; else category/style defaults), imagery mood, density.
  - **Constraints**: no invented facts; neutral copy when facts are missing; length limits; FR typography; tone of voice; `doNotMention` (e.g. negative review content, unpublished prices).
  - `extraInstructions` from the user (≤ 500 chars, sanitized, labelled as operator instructions).
  - `warnings`: e.g. "no display-safe phone", "no image ≥ 1200 px", "single locale detected".
- **Starter spec**: `buildStarterSpec(brief, registry, candidates)` returns a **valid** SiteSpec (BF-033 validator, zero errors):
  - theme from the design direction (contrast-checked);
  - contact from display facts;
  - navigation and pages from the page plan;
  - blocks pre-filled with facts and neutral placeholder copy marked `// TODO-COPY` in a non-rendered annotation map (not in the spec text);
  - assets assigned from top-ranked candidates.

  Engines refine it; the blocks engine (BF-041) can fill it directly.
- **Workspace builder** (implements BF-039 `WorkspacePreparer`):
  ```
  workspace/
  ├── AGENTS.md            # site-agent rules (prompt-registry template site-agent-rules.v1; see BF-044)
  ├── BRIEF.md             # rendered from brief.json (human/agent readable)
  ├── brief.json
  ├── business.json        # display-safe business summary
  ├── facts.json           # display facts only, with ids/provenance/evidence
  ├── site.json            # starter spec (valid)
  ├── schema/site-spec.schema.json
  ├── blocks/<type>.md + <type>.schema.json   # catalog from BF-033
  ├── assets/assets.json + previews/*         # BF-038 candidates
  ├── context/             # UNTRUSTED materials, each file headed with an untrusted-data notice:
  │   ├── current-site/*.md   (excerpts of the business's current pages)
  │   └── review-themes.md     (themes + counts, no third-party quotes)
  └── .sitekit.json        # sitekit config: locales, strictFacts=true, limits
  ```
  - Deterministic: same inputs give the same bundle hash (sorted keys, fixed timestamps in the tar, stable file order). Packed as `tar.zst`, stored as a `workspace_bundle` artifact, with the hash recorded on the attempt.
  - Size budget ≤ 5 MB (previews downscaled); context budgets per file.
- **APIs**:
  - `GET /v1/businesses/:id/generation-brief?offer=&locales=&style=`: brief + registry summary (counts by kind and usage) + warnings + page plan. Used by the generation UI (BF-046) to preview and adjust before starting.
  - Extend the BF-039 batch item schema with optional `briefOverrides` (`locales`, `pagePlanId` or custom page list from the catalog, `style`, `tone`, `extraInstructions`), validated and applied by the brief builder.
- **Evals** (`packages/ai/evals/extract-site-facts/*.jsonl`, ≥ 50 rows, FR/EN, synthetic pages modelled on real layouts):
  - precision ≥ 98% after verification;
  - verification rejects 100% of seeded hallucinations;
  - recall ≥ 80% for services/prices/hours.

  Page-plan selection test set (≥ 40 businesses across categories).

**Out of scope**
- Engines (→ BF-041, BF-044), quality gates (→ BF-045), the UI for brief preview (→ BF-046), asset sourcing internals (→ BF-038).

## Requirements
### Functional
- `facts.json` never contains `internal` facts or third-party review quotes (property test over generated registries).
- Every extracted fact has verifiable evidence; unverifiable candidates are dropped.
- The starter spec always validates; the brief always explains its choices (reasons + evidence ids).
### Non-functional
- Preparation P95 < 30 s when site intel is cached (excluding AI image generation in BF-038); bundle ≤ 5 MB.
- Reproducible: rebuilding a workspace from the same snapshot and inputs yields an identical hash.

## Design
```
packages/contracts/src/{facts/*.ts, generation/brief.ts}
apps/api/src/modules/generation/
├── domain/brief/{fact-usage.spec.ts, page-plan-selector.ts, positioning.ts, design-direction.ts, brief.ts}
├── application/brief/{build-registry.ts, build-brief.ts, build-starter-spec.ts, preview-brief.ts}
├── infrastructure/brief/{site-fact-extractor.ts, evidence-verifier.ts, normalizers/{price,hours,phone}.ts,
│                         workspace-builder.ts (implements WorkspacePreparer), bundle-packer.ts,
│                         templates/{brief.md.hbs}, page-plans/*.yaml}
└── interface/http/{brief.controller.ts}
apps/api/src/modules/crm/… (org_business_facts overlay + facts API; org-scoped, so it lives in crm, not the global graph)
packages/ai/prompts/{extract-site-facts.v1.md, site-agent-rules.v1.md}
```
- Patterns:
  - Builder (brief, workspace).
  - Specification (fact usage, page-plan matching).
  - Strategy (page plans per category, design direction).
  - Chain of Responsibility (registry sources: golden record → JSON-LD → owner-site extraction → user overlay).
  - Anti-corruption layer (extraction output → typed facts via verifier).
- Evidence verifier: normalize (NFKC, lowercase, collapse whitespace, unify quotes/apostrophes and FR non-breaking spaces), then token-set ratio; numbers via regex extraction and exact normalized match.

## Implementation plan
1. Contracts: fact kinds, registry, brief schema (+ JSON Schema export for agents).
2. Fact usage specification and registry builder from the golden record + JSON-LD + overlay (no AI yet), with tests.
3. Owner-site extraction task, prompt, verifier and normalizers, plus evals.
4. Page-plan templates and selector, positioning and design direction, then brief builder.
5. Starter spec builder (always valid; property tests across synthetic registries).
6. Workspace builder and deterministic packer, wired as the BF-039 `WorkspacePreparer` (replacing the fixture preparer via DI).
7. APIs (brief preview, facts overlay CRUD, batch `briefOverrides`).

## Testing
- **Unit:** fact usage rules (restricted-only → internal; owner-site → display), verifier (true and false evidence; numbers mismatch), normalizers (EU/US price formats, FR hours like « 9h–19h », phone E.164 for +590), page-plan selection by taxonomy prefix, design direction from brand colours.
- **Property:** random registries → `facts.json` has no internal facts; starter spec validates for any registry (including empty: name only).
- **Integration:**
  - business with BF-026/BF-029/BF-030 fixtures → registry snapshot + brief + bundle;
  - same inputs give the same bundle hash;
  - overlay fact overrides the global one;
  - BF-039 flow with the real preparer and FakeEngine reaches `succeeded`.
- **Evals:** extraction precision and recall and seeded hallucination rejection; results attached to the PR.

## Acceptance criteria
- [x] Typed fact model with provenance and display/internal usage rules (licensing-aware).
- [x] Evidence-verified owner-site extraction (evals pass) and user-asserted fact overlay with API.
- [x] Versioned brief with explained page plan, positioning, design direction, selling points, constraints and warnings.
- [x] Always-valid starter spec; deterministic workspace bundle implementing `WorkspacePreparer`.
- [x] Brief preview API and batch `briefOverrides`.

## Agent prompt
```text
Implement BF-040 (Generation brief, verified fact registry and workspace builder).

Read first: AGENTS.md, docs/conventions/ai-engineering.md (§5 fact registry, §6 untrusted data, §11 language),
docs/adr/0010 and 0013, docs/ARCHITECTURE.md §11 (workspace), BF-033 (FactRegistry + validators + catalog), BF-039
(WorkspacePreparer port), BF-026/BF-029/BF-030 outputs, BF-038 (collectCandidates/writeToWorkspace). Skim BF-041,
BF-044 and BF-045 — they consume this workspace.

Rules:
- Facts must be provable: extraction returns evidence; deterministic code verifies it; unverifiable = dropped.
- Licensing-aware usage: restricted-provider-only facts are internal and never reach facts.json or prompts that
  produce prospect-facing content. Third-party reviews never become testimonials.
- Crawled text is untrusted: wrap it, budget it, never place it in system prompts.
- Workspace bundles are deterministic and reproducible; record hashes.
- Page plans and query templates are data (YAML), not code branches.

Verify: pnpm verify && pnpm test:int; run evals (pnpm eval --filter=@bf/ai -- extract-site-facts) and attach results.
```

## References
- docs/conventions/ai-engineering.md §5–§6 · ADR-0010 · ADR-0013 · BF-033 · BF-039
- RapidFuzz-style token set ratio (algorithm reference): https://rapidfuzz.github.io/RapidFuzz/ · schema.org LocalBusiness: https://schema.org/LocalBusiness
