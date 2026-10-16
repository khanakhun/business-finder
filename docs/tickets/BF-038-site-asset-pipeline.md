---
id: BF-038
title: Site asset sourcing pipeline (owner-site images, stock, AI images, logos) with licensing
milestone: M3 Build
epic: site-platform
type: feature
priority: P0
size: L
depends_on: [BF-013, BF-026, BF-035]
blocks: [BF-040, BF-062]
areas: [api, worker, sites, ai]
---

# BF-038 — Site asset sourcing pipeline (owner-site images, stock, AI images, logos) with licensing

## Context
Imagery makes or breaks a preview. A salon or villa agency in Saint-Barthélemy will not be impressed by a site with grey placeholders. Images, however, carry licensing risk:
- Provider photos (Google, Foursquare) may **not** be reused in generated sites ([ADR-0013](../adr/0013-discovery-providers-and-data-licensing.md)).
- The business's own website images are usable for a **private concept preview of that same business**, with an ownership caveat. They need explicit confirmation before going live.
- Stock providers have API guidelines on hotlinking, attribution and download tracking.
- AI-generated images must be honest: illustrative ambience, never presented as the business's real premises, staff or products.

The asset storage and processing basics (upload, variants, EXIF strip, dominant colours) exist in BF-035, and site intel (BF-026) returns `logoCandidates` and `imageCandidates`. This ticket turns those into a **ranked, licensed candidate set** for generation (consumed by BF-040's workspace builder) and an on-demand image search/generate feature for the editor (BF-037).

## Goal
`AssetSourcingService` collects, analyses, ranks and stores images and logos for a business. Sources are its own website, stock providers and AI image generation, plus a deterministic wordmark when no logo exists. Every asset carries license metadata, attribution and usage restrictions that the schema, validator, renderer and go-live flow enforce.

## Scope
**In scope**
- **Source strategies** (`AssetSource` interface: `search(ctx) → AssetCandidate[]`, `materialize(candidate) → SiteAsset`), registered in an `AssetSourceRegistry`:
  1. **OwnerSiteSource**: reads BF-026 `imageCandidates` and `logoCandidates`.
     - Downloads through `SafeHttpClient` with a size cap of 15 MB and an image MIME sniff.
     - Discards images under 600 px on the short side, sprites and icons, tracking pixels and blurry images (variance-of-Laplacian threshold).
     - Deduplicates by sha256 and perceptual hash (dHash, Hamming distance ≤ 6).
     - Stores originals privately and public variants via BF-035.
     - `license = owner_site`, with `license_details.sourceUrl` and `ownershipConfirmed = false`.
  2. **StockSource** adapters behind a `StockProvider` port, each enabled by configuration and API key:
     - **Unsplash:** guidelines require hotlinking the returned `urls`, triggering the `download_location` endpoint when a photo is used, and visible photographer + Unsplash attribution with links.
     - **Pexels:** attribution and link back; check its current guidelines on storage vs hotlinking.
     - Verify each provider's current API terms and rate limits at implementation time and encode them in a per-provider **licensing profile**: `{ hosting: 'self'|'hotlink', attributionTemplate, downloadTrackingRequired, commercialUseAllowed, rateLimit }`.
     - Queries are built from the taxonomy (BF-015) category + style + locale context using curated query templates per category. Examples: "luxury hair salon interior", "caribbean café terrace", "hardware store tools close-up", with "tropical / coastal / minimal" style modifiers. Templates are versioned data, not hard-coded strings.
  3. **AiImageSource**: an `ImageGenerationProvider` port with adapters selected by configuration, e.g. OpenAI Images API or a FLUX-class model via an inference API. Verify current model IDs and pricing.
     - Prompts are rendered from versioned prompt files in the BF-013 prompt registry.
     - Policy enforced in the prompt template **and** by a post-generation vision check: no identifiable people, no text, logos or brand names, nothing presented as the real premises, products or staff. Allowed: illustrative ambience (textures, landscapes, generic objects, abstract interiors).
     - Images go through a safety and moderation check before storage.
     - `license = ai_generated`, with `license_details.provider/model/promptHash`.
     - Costs metered in the BF-013 ledger (`modality: image`) and blocked by the workspace's AI budget guard.
  4. **WordmarkSource**: when no usable logo exists, renders a deterministic SVG wordmark (business name in the site's display font, outlined to paths with `opentype.js` so it needs no font loading, monogram variant for favicons). `license = system_generated` (new enum value).
- **Analysis pipeline** (`asset.analyze` job, after BF-035 processing):
  - Vision tagging (fast tier, structured output): `{ depicts: interior|exterior|product|food|people|team|logo|landscape|texture|other, containsText, containsPeople, identifiablePeople, quality (1–5), heroSuitability (1–5), mood[] }`.
  - Alt text in all site locales, written natively (FR typography rules), ≤ 125 characters, describing content rather than marketing.
  - Focal point via sharp attention/saliency with vision override when people are present.
  - Palette compatibility (dominant colours vs theme palette, a ΔE metric).
  - Untrusted input: image bytes go to the vision model; any text in the image (OCR-like content) is treated as data.
- **Ranking**: `rankCandidates(candidates, { role, style, palette })`, a weighted, explainable score per role (`hero`, `gallery`, `about`, `og`, `logo`, `favicon`). Owner-site images are preferred for `about` and `gallery` when quality ≥ 3. Stock or AI is preferred for `hero` when owner images are low quality. Images with people are never AI-generated.
- **Candidate set for generation**: `collectCandidates(businessId, { locales, pagePlan, style, budget }) → CandidateSet`.
  - Gathers sources in priority order: owner site → stock → AI (only if enabled and the budget allows).
  - Targets N per role (configurable; e.g. hero 3, gallery 12, about 3) and caches per business for 7 days.
  - `writeToWorkspace(set, dir)` writes `assets/assets.json` (id, roles ranked, alt per locale, license, attribution, dimensions, dominant colours, focal point, restrictions) plus low-resolution previews for agents to view.
- **Schema, validator and renderer adjustments** (small, backward-compatible extensions of BF-033/BF-034/BF-036):
  - `assets[].hosting: 'self'|'hotlink'` (default `self`). Hotlink is allowed only when `license = stock` and the provider's profile requires it, with the host in `HOTLINK_ALLOWED_HOSTS`.
  - The `license` enum gains `system_generated`. Add `restrictions` (e.g. `preview_only` for unconfirmed owner-site images). Add `settings.labelAiImages` (default true).
  - The renderer adds hotlink hosts to the CSP `img-src` and to `remotePatterns`. It uses a provider loader (Unsplash imgix parameters `w`, `q`, `fm=auto`, `fit=crop` with focal point) instead of re-hosting.
  - Attribution is rendered by blocks (an unobtrusive caption or footer credits section) as the provider requires.
  - AI images show a discreet "Illustration" label when `labelAiImages` is on.
  - Validator: `preview_only` assets are allowed in preview publications but **block** live publication (consumed by BF-062).
- **Usage tracking**: a `StockUsageTracker` subscriber on `site.published`. On the first publication containing a stock asset that requires download tracking, it calls the provider's tracking endpoint once per (asset, site), idempotently.
- **APIs** (permissions `sites:generate`):
  - `GET /v1/sites/:id/asset-suggestions?role=&q=&source=`: search across sources (stock search results are cached; AI is not triggered here).
  - `POST /v1/sites/:id/assets/import`: materialize a stock or owner candidate into the library.
  - `POST /v1/sites/:id/assets/generate`: AI generation with a prompt (validated by policy), style, aspect ratio and count ≤ 4; returns a job id; results stream via realtime.
  - `POST /v1/businesses/:id/assets/refresh`: re-collect candidates.
  - `POST /v1/sites/:id/assets/:assetId/confirm-ownership`: records who confirmed, how (claim form, email, call) and when; lifts `preview_only`. Used when the business claims its site (BF-048/BF-062).
- **Caching and limits**:
  - Stock search cache (Valkey + `asset_search_cache` table, TTL 7 days, key = provider + normalized query + page).
  - Per-provider token-bucket limiters and circuit breakers (cockatiel).
  - Daily AI image cap per workspace (configuration).

**Out of scope**
- Editor UI for these features (BF-037 integrates the endpoints).
- Video assets.
- Background removal or advanced image editing (possible follow-up).
- Brand/logo design beyond the wordmark.

## Requirements
### Functional
- No provider (Google/Foursquare) photos ever reach a SiteSpec. A test seeds such candidates and asserts they are rejected.
- Every asset in a spec has a license, an attribution when required, and alt text in all site locales.
- Unconfirmed owner-site images can be used in previews but cannot go live.
- AI images never depict identifiable people, text or logos (policy prompt + vision check; failures are discarded and logged).
### Non-functional
- Candidate collection for one business < 45 s P95 without AI images, < 90 s with AI images.
- Stock API usage stays within provider limits under a batch of 20 generations (cache + limiter); verified in an integration test with a mocked provider that enforces limits.

## Design
```
apps/api/src/modules/sites/
├── domain/assets/{asset-candidate.ts, licensing-profile.ts, ranking.ts, image-policy.ts}
├── application/assets/{collect-candidates.ts, suggest.ts, import.ts, generate.ts, confirm-ownership.ts}
├── infrastructure/assets/
│   ├── sources/{owner-site.source.ts, stock.source.ts, ai-image.source.ts, wordmark.source.ts, registry.ts}
│   ├── providers/{unsplash.adapter.ts, pexels.adapter.ts, openai-images.adapter.ts, flux.adapter.ts}
│   ├── analysis/{vision-tagger.ts, alt-text.ts, focal-point.ts, phash.ts, sharpness.ts, palette-fit.ts}
│   ├── processors/{asset-analyze.processor.ts, asset-collect.processor.ts, ai-image.processor.ts}
│   ├── usage/stock-usage-tracker.ts
│   └── workspace/write-assets.ts
packages/ai/prompts/{image-tagging.v1.md, alt-text.v1.md, ai-image.v1.md}
packages/site-schema (extensions) · packages/site-blocks (attribution + AI label) · apps/sites (CSP, loader)
```
- Patterns:
  - Strategy + Registry (sources, providers).
  - Adapter (stock and image APIs).
  - Specification (image policy and restrictions).
  - Chain of Responsibility (download → validate → process → analyze → rank).
  - Decorator (cache, limiter and breaker around providers).
  - Domain events (`asset.analyzed`, `asset.ownership_confirmed`).

## Implementation plan
1. Verify stock provider guidelines (hotlink, attribution, download tracking, limits) and image model options and pricing; write the licensing profiles and an ADR addendum note in ADR-0013.
2. Schema extensions (hosting, license enum, restrictions, `labelAiImages`) and validator rules, with tests and JSON Schema regeneration.
3. OwnerSiteSource with quality filters, dedupe and storage.
4. Analysis job (vision tagging, alt text, focal point, palette fit); prompt files and an eval set (50+ images, EN/FR alt text).
5. Stock adapters with cache, limiter and query templates; usage tracker.
6. AI image source with policy, moderation, budget and cost metering.
7. Wordmark generator.
8. Ranking + `collectCandidates` + workspace writer; APIs.
9. Renderer and block adjustments (CSP, loader, attribution, AI label); visual tests updated.

## Testing
- **Unit:** ranking per role, licensing profile rules, policy specification, pHash dedupe, sharpness threshold on fixture images, wordmark determinism (same input gives the same SVG bytes), query template rendering.
- **Integration** (Testcontainers + MinIO + MSW-mocked providers):
  - Owner-site candidates are downloaded, processed and analyzed.
  - Provider photo candidates are rejected.
  - Unsplash hotlink asset is published and the download endpoint is called exactly once.
  - Rate-limit simulation under a 20-job batch.
  - AI generation is blocked by budget, and an image failing the policy check is discarded.
  - Ownership confirmation lifts `preview_only`.
- **Validator:** a spec with a `preview_only` asset passes for preview and fails for live; a hotlink asset on a non-allowlisted host fails.
- **Evals:** alt-text quality (EN/FR rubric), tagging accuracy on a labelled set (≥ 90% for `depicts`, ≥ 95% for `identifiablePeople`).
- **Visual:** attribution caption and AI label rendering in two styles.

## Acceptance criteria
- [ ] Owner-site, stock (≥ 1 provider), AI image and wordmark sources implemented behind a registry with licensing profiles.
- [ ] Analysis (tags, multilingual alt text, focal point, palette fit, quality) and explainable ranking per role.
- [ ] `collectCandidates` + workspace writer used by BF-040; editor endpoints for suggest/import/generate/confirm.
- [ ] Schema, validator and renderer extensions for hosting, licensing restrictions, attribution and AI labeling.
- [ ] Provider guideline obligations (hotlinking, attribution, download tracking, rate limits) implemented and tested.
- [ ] Budgets and costs for AI images enforced and metered.

## Agent prompt
```text
Implement BF-038 (Site asset sourcing pipeline).

Read first: AGENTS.md, docs/adr/0009 and 0013 (photos/reviews licensing), docs/conventions/security.md (§3 uploads,
§4 SSRF), docs/conventions/ai-engineering.md (§6 untrusted data, §8 vision). Reuse: BF-026 image/logo candidates,
BF-035 asset storage/processing, BF-013 gateway (vision, prompt registry, budgets, ledger), BF-033/BF-034/BF-036
(small extensions only). Skim BF-040 (workspace consumer) and BF-037 (editor consumer).

Rules:
- Verify the current API guidelines and limits of each stock provider and image model before coding; encode them
  as licensing profiles (data), and cite the sources in the PR.
- Provider (Google/Foursquare) photos must never reach a site spec. Unconfirmed owner-site images are preview-only.
- AI images: illustrative only, no people/text/logos, verified by a vision check; costs metered and budgeted.
- All downloads through SafeHttpClient; image bytes are untrusted.
- Schema extensions are backward compatible; regenerate the JSON Schema and update fixtures/tests.

Verify: pnpm verify && pnpm test:int; run the alt-text/tagging evals (pnpm eval --filter=@bf/ai) and attach results.
```

## References
- ADR-0009 · ADR-0013 · BF-026 (image candidates) · BF-035 (assets)
- Unsplash API guidelines: https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines · Unsplash API documentation: https://unsplash.com/documentation · Pexels API documentation and guidelines: https://www.pexels.com/api/documentation/ · sharp: https://sharp.pixelplumbing.com/ · opentype.js: https://opentype.js.org/

## Implementation notes

- **Part 1 (PR 1/2)**:
  - Schema (`@bf/site-schema`, backward compatible): `assets[].hosting` (`self` default, `hotlink`), `restrictions`
    (`preview_only`), licence `system_generated`, `settings.labelAiImages`. Validator: hotlinking only for stock
    images from `hotlinkHosts` (none by default); `preview_only` images are refused with `environment: 'live'`.
  - Library (`site_assets`): `kind` (image/logo), `source` (upload/owner_site/stock/ai/wordmark), `source_url`
    (unique per site: collecting is idempotent), `dhash`, `restrictions`, `ownership`, `analysis`.
  - Owner-site images: the latest website snapshot's image and logo candidates (BF-026), downloaded by
    services/intel (`POST /v1/image-fetch`, its SSRF guard, `image/*` only, ≤ 15 MB), sniffed and decoded within
    limits, judged (provider photo hosts, tracking pixels, sprites, icons, short side < 600 px, blur by variance of the
    Laplacian), deduplicated (sha256 and 64-bit dHash, Hamming ≤ 6), stored privately and processed like uploads
    (BF-035 variants), `preview_only` until ownership is confirmed.
  - Wordmark: the name outlined to SVG paths with opentype.js (DM Serif Display or Lato Bold WOFF), rasterized to a
    1200 px PNG, plus a monogram favicon; deterministic; only when the site has no logo.
  - Analysis job after processing: `assets.analyze_image` (vision, fast tier, prompt v1, synthetic eval set) for tags,
    quality, hero suitability and native alt texts (kept where a person wrote one); sharpness and the saliency focal
    point from sharp.
  - Ranking per role (hero, gallery, about, og, logo, favicon), explainable (every point has a reason), with palette
    fit (CIE76 ΔE); AI images showing people are never offered.
  - API: `GET /v1/sites/:id/asset-suggestions`, `POST /v1/sites/:id/assets/refresh` (a job per site and hour),
    `POST /v1/sites/:id/assets/:assetId/confirm-ownership` (`sites:publish`).
  - Editor: library images keep their kind, restrictions and focal point in the spec; a "Preview only" badge.
- **Planned (part 2)**: stock providers (Unsplash, Pexels) with licensing profiles verified against their current
  terms, search cache, limiter and download tracking; AI image generation with policy check, moderation and budget;
  renderer hotlink CSP, attribution and the AI label; `collectCandidates`/`writeToWorkspace` for BF-040; the editor's
  "Find more images" tab.
