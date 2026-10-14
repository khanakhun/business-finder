---
id: BF-037
title: Visual site editor (Puck) with schema-driven fields, versions and publish
milestone: M3 Build
epic: site-platform
type: feature
priority: P0
size: L
depends_on: [BF-007, BF-034, BF-035]
blocks: [BF-047]
areas: [web, sites, ui]
---

# BF-037 — Visual site editor (Puck) with schema-driven fields, versions and publish

## Context
Generated previews are good starting points, but before sending a link the partner usually needs to fix a phrase, swap a photo, reorder sections or change a colour. Sites are documents (`SiteSpec`, BF-033), not code ([ADR-0009](../adr/0009-schema-driven-website-builder.md)), so a visual editor can edit them safely. We use **Puck** (MIT-licensed React page builder; the hosted "Puck AI" product is not used — our AI editing is BF-047). The canvas must render with the **same** `@bf/site-blocks` components as the public renderer (BF-034), so what you see is exactly what the prospect sees. Every save creates an immutable version through the sites module (BF-035).

Puck moved from `@measured/puck` to the `@puckeditor/core` package at v0.21. Check the current package name, data model (`content`, `root`, `zones`/slots), field API, `resolveData`/`resolvePermissions` semantics and plugin/sidebar layout before coding.

## Goal
At `/sites/[siteId]/edit`, a fast WYSIWYG editor for multi-page, multilingual SiteSpecs. It offers schema-driven fields, live validation, site-level settings (theme, contact, navigation, locales, SEO), versions with diff and restore, conflict-safe saving, and one-click preview publishing. A JSON-only fallback lets admins fix edge cases.

## Scope
**In scope**
- Route `apps/web/src/app/(dashboard)/sites/[siteId]/edit/page.tsx`: full-screen editor layout, outside the dashboard chrome. Permissions: `sites:generate` to edit, `sites:publish` to publish; viewers get a read-only canvas.
- **Puck config generated from the catalog**, not hand-maintained per field:
  - `buildPuckConfig(catalog, blocks, ctx)` creates one Puck component per block type. Each component has a `variant` select and fields derived from the block's Zod schema and catalog metadata (BF-033): labels, help texts, limits and the default props for a new block. The component's `render` delegates to the `@bf/site-blocks` component with the editor's `ImageComponent` and `LinkComponent`.
  - Field mapping table (`field-registry.ts`), with a Strategy per schema kind:
    | Schema kind | Field |
    |---|---|
    | `LocalizedText` | custom field: active-locale input, a "show all locales" toggle, a character counter against `.meta()` limits, and a missing-translation indicator |
    | Markdown-limited `rich_text` | a minimal editor (bold/italic/lists/internal links only), with sanitization identical to the renderer |
    | Enum | select or radio |
    | Asset id(s) | `AssetPicker` |
    | `CtaAction` | `CtaField`: kind select, then conditional inputs; `page` lists site pages; `url` is validated against the allowlist |
    | Fact-backed item (price, testimonial, team member, award) | `FactPicker` |
    | Arrays | Puck array field with item summaries and limits |
  - Unknown schema kinds fail the config build in tests, so new blocks cannot ship without editor support.
- **Data adapters** (pure, framework-free, in `features/site-editor/adapters/`):
  - `specPageToPuckData(spec, pageId)`: blocks become `content` items. Page title and SEO live in Puck `root` props. Block ids are preserved as Puck item ids.
  - `applyPuckDataToSpec(spec, pageId, data)` returns a list of **BF-033 operations** (`addBlock`, `moveBlock`, `updateBlockProps`, `setBlockVariant`, `removeBlock`, `updateText`, …), not a replaced document. Saving therefore reuses `ApplySpecOperations`, produces readable change summaries, and supports undo through operation inverses.
  - Round-trip property: `applyPuckDataToSpec(spec, p, specPageToPuckData(spec, p))` yields no operations.
- **Site settings panel** (custom Puck plugin, or the sidebar if plugins are unsuitable), each section emitting operations:
  - Theme: style family; palette with live contrast check and suggested fixes from the BF-033 validator; font pair preview; radius; density; image treatment.
  - Contact: read-only facts with provenance badges, plus an "override" that creates a user-asserted fact when the BF-040 facts API is available.
  - Navigation: drag to reorder, labels per locale, maximum of 7 items.
  - Header and footer variants.
  - Locales: add a locale, which creates empty strings flagged by validation, with an optional "AI translate missing strings" action that calls BF-047's translation endpoint if available and is hidden otherwise. Remove a locale. Change the default locale.
  - Site SEO and the `settings` flags allowed to editors. `noindex` stays locked to true for previews.
- **Pages**: page switcher with add (from page templates: About, Services, Menu, Contact, Gallery, FAQ, each a catalog-defined block list), rename, slug edit (validated and unique), reorder and delete (with confirmation). Every page action is an operation.
- **Locale switcher** for the canvas (renders the active locale) and **viewport switcher** (mobile, tablet, desktop, full width).
- **Live validation panel**: debounced `validateSite` (and `validateFacts` when a registry snapshot is available) runs in a Web Worker. Issues are grouped by page and block. Clicking an issue selects the block and focuses the field. Errors block publishing; warnings do not.
- **Saving and concurrency**:
  - An explicit **Save** (⌘/Ctrl+S) and autosave of a local draft. The local draft is kept in IndexedDB per `siteId` and `baseVersionId`, and a recovery prompt appears on reload.
  - Save calls `ApplySpecOperations` with `baseVersionId`. A `VERSION_CONFLICT` (409) opens a **conflict dialog**: view the remote diff (BF-035 diff API), rebase local operations onto the latest version (re-apply them; operations that no longer apply are listed), or discard local changes.
  - Unsaved-changes guard on navigation. Undo and redo use Puck history plus operation inverses for settings changes.
- **Publish preview**:
  - The button shows the current publication state (URL, expiry, views).
  - Publishing the current version (BF-035 `PublishPreview`) is blocked when there are validation errors.
  - Copy link, open in a new tab, extend expiry, unpublish.
- **Versions drawer**:
  - A list with author type (user, generation job, chat edit, rollback), time, change summary and quality badge (BF-045, when present).
  - View any version read-only in the canvas.
  - Diff between two versions, rendered from the BF-035 structural diff, with text before/after per locale.
  - Restore, which is a BF-035 `Rollback` that creates a new version.
- **AssetPicker**:
  - Site and workspace asset library (BF-035 `GET /v1/sites/:id/assets`) with search and filters (license, orientation).
  - Upload via presigned URL with a required license declaration and alt text per locale, plus a focal point picker.
  - Shows license and attribution, and blocks provider-restricted assets.
  - A "Find more images" tab appears when BF-038 sourcing endpoints exist (feature-detected).
- **FactPicker**: lists facts of the relevant kind from the business's latest fact registry (BF-040 `GET /v1/businesses/:id/facts`). It degrades to read-only, with the tooltip "Fact management arrives with BF-040", when the endpoint is unavailable.
- **JSON mode** (`sites:admin` only): Monaco or CodeMirror JSON editor with schema validation (JSON Schema from BF-033). Saving goes through `CreateSiteVersion` with a full spec, not operations.
- Performance and DX:
  - Lazy-load the editor bundle.
  - The canvas uses the site's theme CSS variables and the `@bf/site-blocks` stylesheet in an isolated iframe (Puck iframe mode), so dashboard styles never leak.
  - Fonts are served from our origin.
- i18n (EN/FR) for all editor chrome. Keyboard shortcuts with a cheat sheet (`?`). Accessible dialogs and drag-and-drop alternatives (move up and down buttons).

**Out of scope**
- AI chat editing and translation (→ BF-047).
- Stock and AI image sourcing (→ BF-038).
- Fact management backend (→ BF-040).
- Custom domains (→ BF-062).
- Real-time multi-user co-editing (conflict detection is enough for v1).

## Requirements
### Functional
- What the canvas shows is pixel-identical to the renderer for the same version, locale and viewport (same components and CSS).
- Every persisted change is a new immutable version created through BF-035 commands. The editor never writes specs directly.
- Invalid specs can be saved as versions (with stored issues) but cannot be published.
### Non-functional
- Editor interactive in < 2.5 s on a typical site (6 pages, 40 blocks) on a mid-range laptop; field edits re-render the canvas in < 100 ms.
- Validation off the main thread; no input lag while typing.
- No secrets or provider-restricted assets in the client bundle or the editor state.

## Design
```
apps/web/src/features/site-editor/
├── editor-shell.tsx              # layout: top bar (page/locale/viewport switchers, save, publish), panels
├── puck/{build-config.ts, field-registry.ts, components.tsx, iframe-styles.ts, plugins/site-settings.tsx}
├── fields/{localized-text-field.tsx, rich-text-field.tsx, cta-field.tsx, asset-picker/*, fact-picker/*}
├── adapters/{spec-to-puck.ts, puck-to-ops.ts, page-templates.ts}   # pure + property-tested
├── state/{editor-store.ts (zustand), local-draft.ts (IndexedDB), history.ts}
├── validation/{validation.worker.ts, use-validation.ts, issues-panel.tsx}
├── versions/{versions-drawer.tsx, diff-view.tsx, conflict-dialog.tsx, rebase.ts}
└── publish/{publish-button.tsx, publication-popover.tsx}
apps/web/src/app/(dashboard)/sites/[siteId]/edit/page.tsx
```
- Patterns:
  - Adapter (SiteSpec ↔ Puck data).
  - Command with inverse (the BF-033 operations power save, undo and rebase).
  - Strategy registry (schema kind → field).
  - Memento (local draft).
  - Optimistic concurrency with rebase (similar to operational transform but simpler: operations are re-applied and validated).
- Rebase algorithm: fetch the latest version, re-apply the local operation list in order, and collect operations that fail (target block deleted, path missing). Show these as "could not apply" with their human summaries. The user accepts the partial rebase or discards.

## Implementation plan
1. Verify the Puck version, package name and APIs (data model, custom fields, iframe, plugins/sidebar, `resolveData`) and pin it.
2. Write the adapters and the operation diffing (TDD and property tests with fast-check arbitraries from BF-033).
3. Build the Puck config from the catalog plus the field registry. Add a test that every block in the catalog builds.
4. Canvas iframe styling and fonts; check visual parity against the renderer on the fixture sites.
5. Site settings panel, pages and locales; validation worker and issues panel.
6. Save with operations, the conflict dialog with rebase, the local draft and the unsaved guard.
7. Versions drawer (diff/restore) and publish popover.
8. AssetPicker (upload and license) and FactPicker (feature-detected); JSON mode.
9. E2E tests, accessibility pass, performance check.

## Testing
- **Unit and property:** spec ↔ Puck round trip yields no operations for every fixture; random operation sequences from the editor adapters keep specs valid; field registry covers every schema kind; rebase applies or reports operations deterministically.
- **Component:** `LocalizedTextField` (counter, missing locale), `CtaField` (allowlist rejection), `AssetPicker` (license required), `FactPicker` (degraded mode).
- **Visual parity (Playwright):** screenshot of the editor canvas vs the `apps/sites` render of the same version for the four fixtures (mobile and desktop); max pixel diff threshold 0.1%.
- **E2E:**
  - Open a fixture site, edit the hero title in FR and EN, swap an image, reorder blocks, save. A new version appears with a change summary, publish succeeds, and the renderer shows the change.
  - Concurrent edit in two browser contexts gives a conflict dialog; rebase succeeds.
  - A validation error (contrast) blocks publish, and clicking the issue focuses the field.
  - Viewer role is read-only.
- **Accessibility:** axe on the editor chrome (no serious or critical issues); keyboard-only flow to edit text and move a block.

## Acceptance criteria
- [ ] Puck editor with fields generated from the BF-033 schema and catalog; every block and variant is editable; canvas parity with the renderer.
- [ ] Multi-page, multi-locale editing with site settings (theme, contact, navigation, header/footer, locales, SEO).
- [ ] Saves produce operation-based immutable versions; conflict dialog with rebase; local draft recovery; undo and redo.
- [ ] Live validation in a worker with click-to-focus; publish blocked on errors.
- [ ] Versions drawer with diff and restore; publish, extend and unpublish from the editor.
- [ ] AssetPicker with license capture; FactPicker with graceful degradation; JSON mode for admins.
- [ ] Unit, property, visual parity, E2E and accessibility suites pass.

## Agent prompt
```text
Implement BF-037 (Visual site editor with Puck).

Read first: AGENTS.md, docs/adr/0009, docs/ARCHITECTURE.md §10, docs/DOMAIN.md (Site, Site version, Publication),
packages/site-schema (BF-033: schema, catalog, operations, validators), packages/site-blocks (BF-034: SiteRenderer,
injection points), the sites module APIs (BF-035: versions, ops, diff, publish, assets). Skim BF-038, BF-040 and BF-047:
they plug into this editor (image sourcing, facts, chat edit), so leave clean extension points.

Rules:
- Verify the current Puck package (@puckeditor/core since v0.21, formerly @measured/puck) and its APIs before coding;
  pin the version. Do not use hosted/paid Puck services.
- The editor emits BF-033 operations; it never invents its own document model or writes specs directly.
- Fields are generated from the schema/catalog through a registry; add a test that fails when a block or schema kind
  lacks an editor mapping.
- Canvas must render with @bf/site-blocks inside an iframe and match the public renderer (visual parity test).
- Validation runs in a Web Worker; publishing is blocked on errors.
- All UI strings EN/FR; accessible alternatives for drag-and-drop.

Verify: pnpm verify && pnpm e2e (editor suite); attach editor screenshots (EN/FR, mobile/desktop canvas) and the
visual parity report in the PR.
```

## References
- ADR-0009 · docs/ARCHITECTURE.md §10 · BF-033 operations · BF-035 APIs
- Puck docs: https://puckeditor.com/docs · Upgrading to Puck 0.21 (package rename to `@puckeditor/core`): https://puckeditor.com/blog/upgrading-to-puck-021 · Puck repository: https://github.com/measuredco/puck
