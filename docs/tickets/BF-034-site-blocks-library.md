---
id: BF-034
title: Site block component library, design styles and static renderer (@bf/site-blocks)
milestone: M3 Build
epic: site-platform
type: feature
priority: P0
size: L
depends_on: [BF-033]
blocks: [BF-036, BF-037, BF-042, BF-045]
areas: [sites, ui]
---

# BF-034 — Site block component library, design styles and static renderer (@bf/site-blocks)

## Context
Every generated site is rendered by our block library ([ADR-0009](../adr/0009-schema-driven-website-builder.md)). Quality of these components **is** the quality ceiling of all generated sites, so they must look premium (Saint-Barthélemy is a luxury market), be fast (Lighthouse ≥ 95 mobile), accessible (axe clean), bilingual, and render identically in three places: the multi-tenant renderer (`apps/sites`, BF-036), the Puck editor canvas (BF-037), and the agents' static renderer (`sitekit render`, BF-042). The schema and fixtures exist (BF-033).

## Goal
A React component for every block type and variant, five data-driven design styles, theme-to-CSS-variable mapping, curated self-hosted fonts, a `SiteRenderer` composition API (server-first), a static HTML renderer for agents/screenshots, a block gallery, and visual/performance/a11y tests.

## Scope
**In scope**
- Components (React 19, Server Components by default; client islands only for: mobile nav toggle, gallery lightbox, contact form interactivity, map embed): `Header`, `Footer`, and blocks `Hero` (variants: `image-background`, `split`, `image-right`, `minimal`), `Highlights` (`grid`, `icons`, `list`), `Services` (`cards`, `list-with-prices`, `columns`), `Menu` (`sections`, `two-column`), `About` (`text-image`, `story`, `facts`), `Gallery` (`grid`, `masonry`, `carousel`), `Testimonials` (`cards`, `quote`), `Hours` (`table`, `compact`, with "open now" computed client-side in the business's timezone), `Location` (`map-and-address`, `address-only`; map via static MapLibre/OSM tiles or link-out — no third-party tracking), `Contact` (`form-and-channels`, `channels-only`), `CtaBanner` (`solid`, `image`), `Faq` (`accordion` with native `<details>`), `Team` (`grid`), `Booking` (`button`, `embed` for allowlisted providers), `SocialLinks`, `RichText`.
- `BlockRenderer` registry (type → component) and `SiteRenderer` API: `<SitePage spec page locale assetsResolver ctaResolver imageComponent />`; injection points for `ImageComponent` (Next `Image` in `apps/sites`, plain responsive `<img srcset>` in static renders) and `LinkComponent`.
- Styles: five style families (`luxe`, `modern`, `warm`, `minimal`, `coastal`) implemented as **data** (token sets: type scale, letter spacing, spacing rhythm, border/radius, shadows, button styles, section backgrounds, image treatments) applied through CSS variables; theme palette/typography from the spec mapped by `themeToCssVars(theme)`; dark text/light background contrast guaranteed by BF-033 validation.
- Fonts: curated pairs (≈ 10) self-hosted (WOFF2, subset latin + latin-ext for French accents), licenses recorded (OFL), exposed via a shared stylesheet; no runtime calls to Google Fonts.
- Styling: Tailwind CSS v4 compiled to a single shared stylesheet `@bf/site-blocks/styles.css` (components use utility classes + CSS variables); no runtime CSS-in-JS.
- Localization: components receive the active locale and pick strings from `LocalizedText`; dates/hours/currency formatted with `Intl`; FR typography respected in rendering (non-breaking spaces handled by content rules).
- Static renderer `renderStaticPage(spec, pageId, locale, opts) → { html, css }` using `react-dom/server` (full document with inlined critical CSS link to the shared stylesheet, fonts, meta tags, hreflang) — used by `sitekit render/screenshot` and quality gates.
- Block gallery: a dev-only route in `apps/sites` (`/__blocks`) **or** a lightweight Vite page in the package (`pnpm --filter @bf/site-blocks gallery`) rendering every block × variant × style with fixture content; screenshots exported to `packages/site-schema/catalog/thumbnails/` for the catalog (BF-033) and the editor.
- Accessibility: landmarks, single `h1` per page, heading order, focus-visible styles, skip link, reduced-motion support, form labels/errors, touch targets ≥ 44px, alt texts required.
- Performance budgets: no client JS for static blocks; total JS < 50 kB gzipped on a typical page; images lazy-loaded except hero (priority); CLS-safe aspect ratios.
- Tests:
  - Unit (Testing Library): each block renders required content, CTA resolution, locale switching, hours "open now" logic with timezones.
  - Visual regression (Playwright): the four fixture sites × 5 styles × mobile/desktop home pages + each block in two styles; baseline images committed (keep total size reasonable; use PNG compression).
  - Accessibility: axe on all fixture pages (zero serious/critical).
  - Lighthouse CI (`@lhci/cli`) on static renders of fixture sites: performance ≥ 95 (mobile), accessibility ≥ 95, best-practices ≥ 95.

**Out of scope**
- Hosting/routing/tenancy (→ BF-036), editor integration (→ BF-037), forms backend (→ BF-048).

## Requirements
### Functional
- Every block type and variant in the BF-033 catalog has a component; unknown block types fail loudly in dev and are skipped with a logged error in production.
### Non-functional
- Visual quality: premium, uncluttered, consistent spacing; designs reviewed with screenshots in the PR (use the frontend-design skill).
- Deterministic rendering (same input → same HTML), enabling snapshot and caching.

## Design
```
packages/site-blocks/src/
├── blocks/{hero,highlights,services,menu,about,gallery,testimonials,hours,location,contact,cta-banner,faq,team,
│           booking,social-links,rich-text}/{index.tsx, variants/*.tsx}
├── layout/{header.tsx, footer.tsx, skip-link.tsx}
├── renderer/{site-page.tsx, block-renderer.tsx, registry.ts, resolvers.ts}
├── styles/{families/*.ts, theme-vars.ts, base.css, styles.css (built)}
├── fonts/{pairs.ts, files/*.woff2, LICENSES.md}
├── static/{render-static-page.tsx}
└── islands/{mobile-nav.tsx, lightbox.tsx, contact-form.tsx, open-now.tsx}
```
- Patterns: Registry (blocks), Strategy (style families as data), Dependency Injection (image/link components), Islands architecture for interactivity.

## Implementation plan
1. Style system: tokens per family, theme → CSS vars, Tailwind v4 config, fonts.
2. Layout (header/footer) + `SiteRenderer` + registry + resolvers.
3. Blocks one by one (start with hero, services, about, contact, hours, location used by all fixtures).
4. Islands for interactive parts.
5. Static renderer + gallery + thumbnails export.
6. Visual, a11y and Lighthouse test suites; iterate on design quality.

## Testing
See Scope → Tests. All suites runnable locally (`pnpm --filter @bf/site-blocks test`, `test:visual`, `test:a11y`, `test:lighthouse`) and in CI (BF-009 jobs extended).

## Acceptance criteria
- [x] Components for all blocks/variants; five style families; curated self-hosted fonts.
- [x] `SiteRenderer` API with injectable image/link components; static renderer for agents.
- [ ] Block gallery and exported thumbnails.
- [ ] Visual regression, axe and Lighthouse thresholds pass on fixture sites.
- [ ] PR includes screenshots of all four fixture sites in at least two styles.

## Agent prompt
```text
Implement BF-034 (Site block component library, design styles and static renderer).

Read first: AGENTS.md, docs/adr/0009, docs/ARCHITECTURE.md §10, docs/conventions/security.md §8 (CSP for sites),
packages/site-schema (BF-033) including fixtures and catalog.

Rules:
- Design quality is the product here. Use the frontend-design skill if available. Aim for premium, calm,
  editorial layouts suited to luxury Caribbean businesses, while staying fast and accessible.
- Server Components by default; client islands only where interaction requires it.
- No runtime third-party requests (fonts, scripts, analytics). Self-host fonts with recorded licenses.
- Rendering must be deterministic and identical between apps/sites, the editor and the static renderer.

Verify: pnpm verify; visual, axe and Lighthouse suites green; attach screenshots in the PR.
```

## References
- ADR-0009 · docs/ARCHITECTURE.md §10
- Tailwind CSS v4: https://tailwindcss.com/docs · Lighthouse CI: https://github.com/GoogleChrome/lighthouse-ci · axe-core Playwright: https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright · Google Fonts licensing (OFL): https://openfontlicense.org/

## Implementation notes

**Part 1 (library):** `packages/site-blocks`.
- Every block type × variant of the BF-033 schema (the schema's variant names, which differ from the ticket's draft
  list: e.g. hero `split|centered|image_full|minimal`), header (`simple|centered|transparent`), footer
  (`simple|columns`), skip link, preview banner. `BLOCK_COMPONENTS` is typed so a missing type does not compile; an
  unknown type throws in `mode: 'development'` and is skipped with a logged error otherwise (the default).
- `SitePage` (the ticket's `SiteRenderer`) takes `spec`, `page`, `locale`, `assetsResolver`, `ctaResolver`,
  `imageComponent`, `linkComponent`, `hrefForPage`, `facts`, `contactFormAction`, `mapImage`, `agencyName`, `mode`,
  `logger`. Blocks receive a `RenderContext` prop (Server Components have no React context).
- Five style families as data (`src/styles/families/*.ts`) → `--bf-*` variables + `data-*` switches; Tailwind v4.3.3
  CLI builds `dist/styles.css`. Fonts: the seven BF-033 pairs (12 families, OFL) copied from Fontsource 5.3.0
  (latin + latin-ext, upright and italic) at build; licenses in `LICENSES.md` and `dist/fonts/licenses/`.
- No client JS for static blocks: mobile menu and photo viewer are native popovers. Islands: "open now" (browser
  clock, business time zone; empty placeholder on the server), contact form (posts JSON to `contactFormAction`,
  disabled without it), booking embed (sandboxed frame loaded only on request, allowlisted providers;
  `embedOrigins(spec)` for the CSP).
- Static renderer `renderStaticPage` / `renderStaticSite` (`@bf/site-blocks/static`, Node): doctype, lang, title,
  description, robots on previews, canonical and hreflang (with `origin`), Open Graph, font preloads, the stylesheet
  linked or inlined, and LocalBusiness JSON-LD with `<` escaped.
- Deviations: icons are inline SVG (Lucide outlines, ISC) because lucide-react 1.x ships icons as client components;
  maps are a link to OpenStreetMap or a static image supplied by the renderer (`mapImage`), never third-party tiles
  at runtime; the spec has no time zone, so "open now" uses the address country's single time zone (none for
  multi-zone countries; DECISION in `format/hours.ts`); fonts stay at the seven curated pairs of BF-033 (the ticket
  said ≈ 10).
- `@bf/site-schema` exports `Price` and its fixtures (`./fixtures/*`); boundary rule `site-blocks-browser-safe`.

**Part 2 (planned):** gallery and thumbnails, visual regression, axe and Lighthouse suites, CI job, screenshots.

