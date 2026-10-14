---
id: BF-023
title: Search and listing UI (prompt bar, intent chips, table, map, facets, discovery panel)
milestone: M1 Find & List
epic: search-listing
type: feature
priority: P0
size: L
depends_on: [BF-007, BF-010, BF-020, BF-021, BF-022]
blocks: [BF-024, BF-032, BF-046]
areas: [web, ui]
---

# BF-023 — Search and listing UI (prompt bar, intent chips, table, map, facets, discovery panel)

## Context
This is the screen the sales partner lives in ([PRD J1](../PRD.md#5-key-user-journeys)). They type a prompt, see the parsed intent as editable chips, browse results in a table or on a map, refine with facets, save searches, and—when the listing is thin—launch a discovery run with a cost estimate and watch results arrive live. APIs exist: intent (BF-021), search/facets/saved searches/lists/export (BF-022), discovery runs (BF-020), realtime (BF-012). UI kit and shell exist (BF-007).

## Goal
A fast, keyboard-friendly, bilingual search experience at `/search` that turns prompts into structured, shareable (URL-encoded) searches, supports table and map views with facets, saved searches and lists, bulk actions, and an integrated discovery flow with live progress.

## Scope
**In scope**
- `/search` page:
  - **Prompt bar**: multiline-capable input with placeholder examples (EN/FR), submit → `POST /v1/search/intent` → chips; loading shimmer; clarification prompt UI (options as buttons) when `needsClarification`.
  - **Intent chips** (editable): categories (opens `CategoryPicker` from BF-015), location (popover with candidate list + mini map preview + radius slider for point areas + "draw area" option), filters (each filter a chip with an editor popover: website presence, rating range, reviews range, has email/phone, pipeline status, tags, added within), keywords, mode toggle (**My listings / Discover new / Both**), sort.
  - URL state with `nuqs` (intent + filters + sort + view + cursor) → shareable/restorable; back/forward works.
  - **Results table** (`DataTable` from `@bf/ui`): columns name, category, locality, website status icon (none/has/weak later), rating & reviews, email status, phone, pipeline status, score badge (placeholder until BF-031; hidden column), last activity, added via; column visibility & density; infinite scroll with virtualization; row selection; row click opens the business detail (BF-024 route; until then a side sheet with summary).
  - **Map view** (MapLibre GL via `react-map-gl/maplibre`, tiles configurable — default OpenFreeMap style URL; attribution shown): clustered markers, hover sync with table, fit to area, area outline, draw rectangle/polygon tool to set a custom area (`POST /v1/geo/areas`).
  - **Facets sidebar**: category tree counts, status, website presence, email availability, rating bands, localities; clicking applies filters; counts update with filters.
  - **Saved searches**: save dialog (name, visibility, notify new matches), dropdown to load, manage page `/search/saved`; **lists**: add selection to list, lists page `/lists` and `/lists/[id]`.
  - **Bulk action bar** (appears on selection): add to list, add/remove tags, set pipeline status (respects allowed transitions; partial failures reported), export CSV (selected or all results), and placeholders disabled with tooltip for *Create sites* (BF-046) and *Email/enroll* (M4) — implemented as registered actions so later tickets plug in without editing this page.
  - **Discovery panel** (drawer): shows providers to use (from `GET /v1/discovery/providers`, user can toggle), estimate (`POST /v1/discovery-runs/estimate`: tiles, calls, cost range, expected results), budget input, auto-enrich toggle, start → live progress (realtime `discovery.run.progressed`: progress bar, counts created/merged/duplicates, cost so far), cancel button; results appear in the table (filter "added via this run" chip) as they arrive; completion toast + notification.
  - Empty states: no results → suggest discovery; no prompt → examples and recent searches; errors with trace id.
- Keyboard: `/` focus prompt, `j/k` move, `x` select, `Enter` open, `m` toggle map, `s` save search, `⌘K` commands (register "New search", "Run discovery", "Saved searches").
- Performance: debounce filter changes; prefetch next page; keep table virtualized; map lazy-loaded.
- i18n EN/FR for all strings; number/date formatting by locale.

**Out of scope**
- Business detail page (→ BF-024). Score columns/badges data (→ BF-031/BF-032). Site generation and outreach actions (→ BF-046, M4).

## Requirements
### Functional
- Prompt → chips → results works for EN and FR prompts; editing a chip re-runs search without re-parsing.
- Discovery flow with estimate, start, live progress and cancel.
### Non-functional
- Interaction to next paint < 200 ms for filter changes (excluding network); map bundle lazy-loaded.
- WCAG 2.1 AA (keyboard operability of chips, table and map controls; map has a list alternative).

## Design
```
apps/web/src/app/(dashboard)/search/{page.tsx, saved/page.tsx}
apps/web/src/app/(dashboard)/lists/{page.tsx, [id]/page.tsx}
apps/web/src/features/search/{prompt-bar.tsx, intent-chips/*, results-table.tsx, results-map.tsx, facets.tsx,
  bulk-actions/{registry.ts, bar.tsx}, discovery-panel/*, url-state.ts, hooks/*}
```
- Bulk actions registry pattern (`registerBulkAction({ id, label, icon, permission, isEnabled(selection), run })`).
- Query keys centralized; realtime invalidations for discovery progress and business updates.

## Implementation plan
1. URL state model + hooks (search, facets, intent) with tests.
2. Prompt bar + chips + editors (CategoryPicker, location popover, filter editors).
3. Results table with virtualization + selection + bulk action registry.
4. Facets sidebar.
5. Map view (lazy) + draw tool.
6. Saved searches + lists pages.
7. Discovery panel with realtime.
8. Keyboard shortcuts, empty/error states, i18n, a11y pass.
9. E2E tests with fake LLM + fake discovery provider.

## Testing
- Unit/component: URL state serialization; chip editors; bulk action registry enable/disable by permission; facet click → filter.
- E2E (Playwright, fake providers): FR prompt → chips → results; edit category chip → results change; save search → reload page → restored; select 3 rows → add to list; discovery estimate → start → progress → results appear → completion toast; map toggle shows markers; keyboard navigation; axe checks.

## Acceptance criteria
- [ ] `/search` supports prompt → editable chips → results (table + map) with facets, EN/FR.
- [ ] URL fully represents the search; back/forward and sharing work.
- [ ] Saved searches and lists usable end-to-end.
- [ ] Bulk actions via registry (list, tags, status, export) with permissions.
- [ ] Discovery panel with estimate, live progress, cancel; results stream into the table.
- [ ] E2E and a11y tests pass.

## Agent prompt
```text
Implement BF-023 (Search and listing UI).

Read first: AGENTS.md, docs/PRD.md §5 (J1), docs/ARCHITECTURE.md §8 (F1, F2), docs/conventions/coding-standards.md §3,
docs/conventions/testing.md §7. Reuse: shell + @bf/ui + api client (BF-007), auth/permissions (BF-010),
realtime (BF-012), CategoryPicker (BF-015), intent API (BF-021), search APIs (BF-022), discovery APIs (BF-020),
geo APIs (BF-017).

Rules:
- This is the most-used screen; invest in interaction quality (use the frontend-design skill if available).
- URL is the state. Never store search state only in component memory.
- Bulk actions must go through the registry so later tickets add actions without editing this page.
- Verify current APIs for MapLibre GL / react-map-gl and nuqs before coding.

Verify: pnpm verify && pnpm e2e; attach screenshots (EN/FR, table/map, discovery in progress).
```

## References
- docs/PRD.md §5 · docs/ARCHITECTURE.md §8 · docs/conventions/testing.md §7
- MapLibre GL JS: https://maplibre.org/maplibre-gl-js/docs/ · react-map-gl: https://visgl.github.io/react-map-gl/ · OpenFreeMap: https://openfreemap.org/ · nuqs: https://nuqs.dev/ · TanStack Table: https://tanstack.com/table
