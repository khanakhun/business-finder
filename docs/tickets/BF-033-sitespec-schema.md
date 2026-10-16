---
id: BF-033
title: SiteSpec schema, semantic validation, operations and block catalog (@bf/site-schema)
milestone: M3 Build
epic: site-platform
type: feature
priority: P0
size: L
depends_on: [BF-004]
blocks: [BF-034, BF-035, BF-040, BF-042]
areas: [contracts, sites]
---

# BF-033 — SiteSpec schema, semantic validation, operations and block catalog (@bf/site-schema)

## Context
Generated websites are **documents**, not code ([ADR-0009](../adr/0009-schema-driven-website-builder.md)): every engine (LLM composer, Claude Agent SDK, Claude Code, Codex) outputs a `SiteSpec`, rendered by our block library on our domain, editable in Puck and by chat. The schema is therefore the most important contract of the website platform: it must be expressive enough for good local-business sites (2–6 pages, FR/EN), strict enough to guarantee quality and safety (no invented facts, no arbitrary URLs/HTML), and self-documenting so agents can use it as a tool contract (`--json-schema`, `--output-schema`, MCP tools). This ticket depends only on `@bf/contracts` and can start right after M0 (parallel track).

## Goal
`@bf/site-schema` defines `SiteSpec` v1 (Zod) with rich field descriptions, a semantic validator, a facts validator interface, invertible high-level edit operations, schema migrations, JSON Schema export, block catalog metadata for agents and editors, and four realistic fixture specs.

## Scope
**In scope**
- `SiteSpec` v1 (`schemaVersion: 1`):
  - `locales`: 1–4 of `fr|en|nl|es|de` (site locales; dashboard i18n is separate); `defaultLocale` ∈ locales.
  - `theme`: `style` (`luxe|modern|warm|minimal|coastal`), `palette` (`primary`, `secondary?`, `accent`, `background`, `surface`, `text`, `mutedText` — hex), `typography` (`pairId` from a curated list of font pairs with fallbacks), `radius` (`none|sm|md|lg|full`), `density` (`compact|comfortable|airy`), `imageTreatment` (`plain|rounded|framed`).
  - `contact` (single source of truth for contact facts used by header/footer/contact/CTAs): `phone?`, `email?`, `whatsapp?`, `address?` (components + formatted), `geo?` {lat,lng}, `hours?` (weekly spec + exceptions note), `socials?[]`, `bookingUrl?` (allowlisted host), each value carrying a `factId` (string) when it comes from the fact registry.
  - `layout`: `header` (variant `simple|centered|transparent`, `logoAssetId?`, `showCta`, `cta?`), `footer` (variant `simple|columns`, `showSocials`, `showHours`, `tagline?`).
  - `navigation`: items referencing page ids with localized labels (≤ 7).
  - `pages[]` (1–8): `id`, `slug` (`''` home; kebab-case; unique), `title` (LocalizedText), `seo` (`title`, `description` localized, `ogImageAssetId?`), `blocks[]` (1–20).
  - Blocks — discriminated union on `type`, each with `id` (nanoid), `variant`, `props`:
    `hero`, `highlights`, `services` (items with optional `price` that must reference a price fact), `menu` (sections/items; prices fact-backed), `about`, `gallery` (3–12 asset ids), `testimonials` (items must reference `testimonial` facts — **no fabricated testimonials ever**), `hours`, `location` (map/directions), `contact` (form + channels toggles), `cta_banner`, `faq` (answers may not contain unsupported factual claims), `team` (fact-backed only), `booking` (embed/link to the business's existing booking provider from facts), `social_links`, `rich_text` (limited markdown: paragraphs, bold, italic, lists, links to own pages only).
  - `CtaAction`: `{ kind: 'call'|'email'|'whatsapp'|'page'|'booking'|'directions'|'url', label: LocalizedText, pageId?, url? }` — call/email/whatsapp/directions/booking resolve from `contact`; `url` only for allowlisted hosts (business's own domain, known booking providers).
  - `assets[]`: `id`, `kind` (`image|logo|icon`), `url` (our storage/CDN host only), `width`, `height`, `alt` (LocalizedText), `license` (`owner_site|stock|ai_generated|uploaded`), `attribution?`, `focalPoint?`, `dominantColors?`. `provider_restricted` assets are not allowed in a spec.
  - `seo`: site title/description localized; `settings`: `noindex` (true for previews), `previewBanner` (true), `analytics` (`cookieless|none`), `contactForm` (`enabled`).
  - `LocalizedText` = record of the site's locales → string; every localized field must have **all** site locales (enforced by the semantic validator).
  - Field-level `.describe()` texts written for agents (what good content looks like, length targets, examples) and `.meta()` limits (min/max lengths per field: hero title ≤ 60, subtitle ≤ 160, SEO description 120–160, etc.).
- Semantic validator `validateSite(spec) → Issue[]` (`path`, `code`, `severity` error|warning, `message` actionable): locale completeness; home page present; unique slugs/ids; nav/page/asset/CTA references resolve; field length limits; alt text present in all locales; palette contrast (WCAG AA 4.5:1 for text/background and text/surface, 3:1 for large text/accents) with suggested fixes; no external URLs except allowlist; block count limits; at least one contact channel; booking block requires `bookingUrl`; heading structure (exactly one hero/h1-equivalent per page).
- Facts validator interface: `FactRegistry` type (facts with `id`, `kind`, typed `value`, `locale?`, `source`, `confidence`) and `validateFacts(spec, registry) → Issue[]`: contact values equal registry values; every price/menu price/testimonial/team member/year/award referenced must exist in registry; literal numbers/phones/emails/prices in free text detected (regex) and must match facts — else error. (The registry builder is BF-040.)
- Operations (`ops.ts`): high-level, validated, **invertible** operations returning `{ spec, inverse }`: `addPage`, `removePage`, `renamePage`, `reorderPages`, `addBlock`, `removeBlock`, `moveBlock`, `updateBlockProps` (deep-partial), `setBlockVariant`, `setTheme`, `setContact`, `setNavigation`, `updateText(path, locale, value)`, `addAsset`, `assignAsset`; batch apply with all-or-nothing semantics. Used by Puck adapter (BF-037), chat edit (BF-047) and `sitekit ops` (BF-042).
- Migrations: `migrateSpec(input: unknown) → SiteSpec` with versioned upcasters (v1 baseline + test harness for future versions).
- JSON Schema export (`pnpm site-schema:jsonschema` → `packages/site-schema/generated/site-spec.schema.json`) — draft 2020-12, descriptions preserved; checked into git (agents and the runner image consume it); a reduced "engine result" schema for Codex `--output-schema`.
- Block catalog metadata (`catalog.ts`): per block type — title, purpose, when to use / avoid, variants with descriptions and preview thumbnails path (filled by BF-034), props documentation, limits, good/bad content examples (EN/FR). Generator `pnpm site-schema:catalog` → markdown files consumed by agent workspaces (BF-040/BF-042).
- Fixtures (`fixtures/*.json`, synthetic businesses only): `salon-gustavia` (FR/EN, luxe), `cafe-saint-jean` (FR/EN, warm, menu), `hardware-store-lorient` (FR/EN, modern, services), `villa-agency` (EN/FR, luxe, booking link), plus `broken-*.json` fixtures for validator tests.

**Out of scope**
- Rendering components (→ BF-034), persistence (→ BF-035), fact registry construction (→ BF-040), editor field mapping (→ BF-037).

## Requirements
### Functional
- All fixtures validate with zero errors; each broken fixture yields exactly the expected issue codes.
- Every operation's inverse restores the original spec (property-based tests).
### Non-functional
- Package has no Node-only APIs (used in browser editor and in the runner).
- Validation of a typical spec < 5 ms.

## Design
```
packages/site-schema/src/
├── spec/{site.ts, theme.ts, contact.ts, layout.ts, page.ts, blocks/*.ts, cta.ts, assets.ts, localized.ts}
├── validate/{semantic.ts, contrast.ts, facts.ts, limits.ts, issues.ts}
├── ops/{operations.ts, apply.ts, inverse.ts}
├── migrate/{index.ts, v1.ts}
├── catalog/{catalog.ts, render-markdown.ts}
├── fonts.ts                 # curated font pairs (ids, families, fallbacks, license)
└── index.ts
packages/site-schema/{fixtures/*, generated/site-spec.schema.json}
```
- Patterns: Composite (pages/blocks), Command with inverse (operations → undo), Specification (validation rules), Registry (blocks, fonts).

## Implementation plan
1. Draft the schema with descriptions; review against the four fixture businesses (write fixtures first — they drive the design).
2. Semantic validator rules + contrast utility (TDD with broken fixtures).
3. Facts validator interface + literal detectors.
4. Operations + inverses (property-based tests with fast-check arbitraries for specs).
5. Migrations harness, JSON Schema export, catalog + markdown generator.
6. README: how to add a block type (schema → catalog → component (BF-034) → Puck field (BF-037) → tests).

## Testing
- Unit: every validation rule (positive/negative), contrast math against known pairs, CTA resolution, locale completeness, literal detection (phones/prices/years in text).
- Property: operation/inverse round trips; random valid specs stay valid after valid ops.
- Snapshot: JSON Schema export and catalog markdown deterministic.

## Acceptance criteria
- [ ] `SiteSpec` v1 with all blocks, theme, contact, layout, navigation, assets, SEO and settings — documented field by field.
- [ ] Semantic and facts validators with actionable issues; fixtures validate; broken fixtures fail as expected.
- [ ] Invertible operations with property tests.
- [ ] JSON Schema and block catalog generated and committed.
- [ ] README explains extending the block set.

## Agent prompt
```text
Implement BF-033 (SiteSpec schema, validation, operations and block catalog) in packages/site-schema.

Read first: AGENTS.md, docs/adr/0009-schema-driven-website-builder.md, docs/adr/0010, docs/ARCHITECTURE.md §10–§11,
docs/conventions/ai-engineering.md §5 (fact registry), docs/DOMAIN.md (Site, SiteSpec, Block, Theme, Fact registry).
Skim BF-034, BF-037, BF-040, BF-042, BF-047 — they all consume this package.

Rules:
- Start from the four fixture businesses: write their specs first, then shape the schema around real needs.
- The schema is a tool contract for AI agents: every field gets a precise .describe() with length targets and
  examples; enums over free text wherever possible.
- Safety invariants are schema/validator-enforced, not conventions: no fabricated testimonials/prices, no
  external URLs outside the allowlist, no raw HTML.
- Browser-safe package (no Node APIs).

Verify: pnpm verify (coverage ≥ 90% for validate/ and ops/); regenerate JSON Schema and catalog with no diff.
```

## References
- ADR-0009 · ADR-0010 · docs/ARCHITECTURE.md §10–§11 · docs/conventions/ai-engineering.md §5
- WCAG contrast: https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html · JSON Schema 2020-12: https://json-schema.org/

## Implementation notes
- **Deviation:** `url` actions go to the business's own domains only (the ticket also allowed known booking
  providers): a booking page is reached through the `booking` action, which resolves to the fact-backed
  `contact.bookingUrl` — a provider host also serves pages anyone can create. Engines (BF-040/BF-042) emit `booking`
  actions for booking links.
