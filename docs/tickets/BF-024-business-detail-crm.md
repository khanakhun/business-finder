---
id: BF-024
title: Business detail page and CRM basics (pipeline, owner, notes, tasks, activity, duplicates)
milestone: M1 Find & List
epic: search-listing
type: feature
priority: P0
size: L
depends_on: [BF-012, BF-016, BF-023]
blocks: [BF-032, BF-046, BF-048, BF-049, BF-051, BF-053, BF-057, BF-062]
areas: [api, web]
---

# BF-024 — Business detail page and CRM basics (pipeline, owner, notes, tasks, activity, duplicates)

## Context
After finding businesses, the partner qualifies and works them: pipeline status, owner, notes, tasks/reminders, tags, do-not-contact, and a timeline of everything that happened ([PRD J2](../PRD.md#5-key-user-journeys), [DOMAIN.md §3.1](../DOMAIN.md#31-pipeline-status-orgbusiness)). The detail page is also the hub where M2–M4 features plug in (audit, scores, sites, outreach) — so it is built with **extensible tabs and actions**. `org_businesses` exists minimally (BF-014); possible duplicates exist (BF-016); events and realtime exist (BF-012).

## Goal
A rich `/businesses/[id]` page and a `/pipeline` kanban, backed by a `crm` module with a pipeline state machine, owner/tags/do-not-contact, notes, tasks, an activity timeline fed by domain events, and duplicate review — all extensible for later epics.

## Scope
**In scope**
- `crm` module schema extensions: `org_businesses` add `owner_user_id`, `tags` text[] (if not added by BF-022), `status_changed_at`, `disqualified_reason`, `lost_reason`, `do_not_contact_reason`, `notes_count`, `open_tasks_count`, `next_task_due_at`.
  - `notes`: `id`, `organization_id`, `business_id`, `author_id`, `body_markdown`, `pinned`, timestamps (soft delete with `deleted_at`).
  - `tasks`: `id`, `organization_id`, `business_id`, `assignee_id`, `created_by`, `type` (`call|email|visit|follow_up|other`), `title`, `due_at`, `status` (`open|done|cancelled`), `completed_at`, timestamps; index (`organization_id`, `assignee_id`, `status`, `due_at`).
  - `activities`: `id`, `organization_id`, `business_id`, `type`, `actor` jsonb, `data` jsonb, `occurred_at`; index (`organization_id`, `business_id`, `occurred_at desc`).
- Domain: `OrgBusiness` aggregate with pipeline state machine (typed transition table from DOMAIN.md §3.1; automatic transitions exposed as commands used by later tickets: `markContacted`, `markEngaged`), reasons required for `lost`/`disqualified`, do-not-contact toggle (emits `crm.do_not_contact_set` → compliance suppression subscriber added in BF-049).
- Use cases & APIs (`business:write` unless read): change status, assign owner, set tags (add/remove), toggle do-not-contact (with reason), notes CRUD (markdown sanitized on render), tasks CRUD + complete, activity list (cursor), `GET /v1/pipeline` (board data grouped by status with counts, filters: owner, tags, category, tier), `GET /v1/tasks?assignee=me&due=today|overdue|upcoming`.
- Activity feed: subscriber listening to relevant events (`business.created/updated/merged`, `org_business.status_changed`, notes/tasks events, later `outreach.*`, `site.*`, `generation.*`, `score.updated`) → `activities` rows with a typed `ActivityType` registry (renderers per type in the web app; later tickets register new renderers).
- Detail page `/businesses/[id]`:
  - Header: name, category, locality, rating, website link, status select (allowed transitions only), owner select, tags, do-not-contact switch, quick actions **registry** (Open website, Call `tel:`, WhatsApp `wa.me` placeholder (BF-057 fills message), Enrich now (enabled after BF-027), Generate site (BF-046), Send email (BF-052)) — actions registered by later tickets.
  - Tabs **registry**: Overview (facts with provenance tooltips/source badges, map, hours, contacts summary, categories), Contacts (list with type/subtype/verification/provenance; add/edit manual contact), Activity (timeline + notes composer + tasks panel). Later tickets register: Website audit (BF-030), Reviews (BF-029), Scores (BF-032), Sites (BF-046), Outreach (BF-052).
  - Possible duplicates banner → compare dialog (side-by-side fields with source badges and match reasons) → merge (calls BF-016) or dismiss.
  - Realtime updates (status changes, new activity).
- `/pipeline` kanban (dnd-kit): columns per status with counts; cards show name, category, locality, tier/score (when available), next task, owner avatar; drag to change status (invalid transitions rejected with toast); filters; keyboard alternative (status menu on card).
- `/tasks` page: my tasks (today/overdue/upcoming), complete inline, link to business.

**Out of scope**
- Audit, reviews, scores, sites, outreach tabs (registered by their tickets). Email/call actions themselves.

## Requirements
### Functional
- Illegal pipeline transitions are rejected server-side (422 `INVALID_STATE_TRANSITION`) and prevented in UI.
- Merging duplicates from the dialog re-points CRM data (notes, tasks, activities, org state) to the survivor.
### Non-functional
- Detail page TTFB < 300 ms (server components fetching via API), tabs lazy-loaded.
- Notes rendered safely (sanitized markdown; no raw HTML).

## Design
```
apps/api/src/modules/crm/{domain/{org-business.ts, pipeline.ts, activity-types.ts}, application/*, infrastructure/*, interface/*}
apps/web/src/app/(dashboard)/businesses/[id]/page.tsx
apps/web/src/features/business/{header.tsx, tabs/registry.ts, tabs/{overview,contacts,activity}.tsx,
  actions/registry.ts, duplicates/*, activity/renderers/*}
apps/web/src/app/(dashboard)/{pipeline,tasks}/page.tsx
```
- Patterns: State Machine, Registry (tabs, actions, activity renderers), Observer (activity subscriber).

## Implementation plan
1. Pipeline state machine + aggregate (unit tests for every transition).
2. Schema + repositories + use cases + APIs (integration tests incl. authz).
3. Activity subscriber + registry.
4. Detail page with tabs/actions registries, overview/contacts/activity tabs.
5. Duplicates banner + compare/merge dialog.
6. Kanban + tasks pages.
7. E2E tests.

## Testing
- Unit: transitions table (allowed/denied), reasons required, counters maintenance.
- Integration: status change emits event + activity; notes/tasks CRUD with org isolation; merge re-points CRM rows; pipeline board aggregation.
- E2E: open business from search → change status → note → task → appears in /tasks → complete; drag card across columns; invalid drag rejected; duplicate merge flow (seeded duplicate pair).

## Acceptance criteria
- [ ] Detail page with header, Overview, Contacts and Activity tabs; tabs/actions/activity renderers are registries.
- [ ] Pipeline state machine enforced server-side; kanban with drag & drop and keyboard alternative.
- [ ] Notes, tasks, tags, owner, do-not-contact with reasons; activity timeline from events (realtime).
- [ ] Duplicate review and merge from the UI.
- [ ] E2E tests pass (EN/FR).

## Agent prompt
```text
Implement BF-024 (Business detail page and CRM basics).

Read first: AGENTS.md, docs/DOMAIN.md §2–§3.1 and §4, docs/PRD.md §5 (J2), docs/ARCHITECTURE.md §5.1 (crm).
Reuse: business graph + track (BF-014), merge/split + possible duplicates (BF-016), events/realtime (BF-012),
search UI patterns and registries (BF-023), shell/UI kit (BF-007), permissions (BF-010).

Rules:
- The page is a plug-in host: implement tab, quick-action and activity-renderer registries and use them for the
  built-in tabs too.
- State machine logic lives in crm/domain and is exhaustively unit-tested; the UI mirrors allowed transitions
  from an API response, never a duplicated table.
- Render notes markdown safely (sanitize; no raw HTML).

Verify: pnpm verify && pnpm test:int && pnpm e2e; screenshots of detail page and kanban (EN/FR).
```

## References
- docs/DOMAIN.md §3.1 · docs/PRD.md §5 · docs/ARCHITECTURE.md §5
- dnd-kit: https://dndkit.com/
