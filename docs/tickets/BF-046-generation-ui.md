---
id: BF-046
title: Generation UI — "Create sites" from selection, priorities, engines, live batch board, agent console, review queue
milestone: M3 Build
epic: generation
type: feature
priority: P0
size: L
depends_on: [BF-023, BF-024, BF-039, BF-040, BF-045]
blocks: []
areas: [web, ui]
---

# BF-046 — Generation UI: "Create sites" from selection, priorities, engines, live batch board, agent console, review queue

## Context
This is the screen the user described:
1. Select a salon, a hardware store and a café.
2. Click **Create**.
3. Set which starts first.
4. Choose one by one or parallel, and which agent does what (e.g. 2 × Claude Code + 2 × Codex).
5. Watch it happen.
6. Get shareable previews on our domain.

The backend exists:
- orchestration, priorities, concurrency, events, SSE (BF-039);
- brief preview and overrides (BF-040);
- quality reports and review actions (BF-045);
- listing selection (BF-023) and business detail registry (BF-024).

This UI must make a complex, long-running, parallel process feel **calm and controllable**.

## Goal
A "Create sites" flow from any selection, with per-item priority (drag to order), engine choice with availability/cost/time hints, sequential vs parallel mode, brief preview and overrides, and an estimate. It also adds:
- a live **batch board**;
- a **job console** that streams agent activity (tool calls, file changes, screenshots, cost vs budget);
- quality reports;
- a **needs-review queue**;
- workspace generation settings;
- a **Sites** tab on the business page.

## Scope
**In scope**
- **Entry points**:
  - Listing bulk action "Create sites (N)" (BF-023 selection, max 50) and "Create site" on rows.
  - Business detail header button.
  - Lists/pipeline bulk actions.
  - Keyboard: `g s` opens the generation home; `c` on a focused row opens the create flow.
- **Create sites sheet** (`features/generation/create/`):
  - **Items**: sortable list (dnd-kit; keyboard alternatives move up/down), where position = priority. Each row shows the business name, category, area, score tier badge, and an existing-site indicator (regenerate vs new).
  - **Engine** select per item: Auto, Blocks, Claude Agent SDK, Claude Code, Codex. Each option shows availability (from `GET /v1/generation/engines`), typical cost and duration, and live load ("2 running · 3 waiting"). Disabled engines show why (no key, feature off, version unsupported).
    - "Apply to all" and an **"Assign engines…"** helper that distributes items across engines by pattern. Example: "2 × Claude Code + 2 × Codex + rest Blocks" assigns by position. The pattern is saved as a workspace preset.
  - **Run mode**: "One by one (in this order)" (`maxParallel = 1`) or "In parallel (up to N)" (`maxParallel = N`, defaults to the sum of the selected engines' available slots). A small helper text explains how per-engine and workspace limits apply.
  - **Brief preview per item** (expandable; `GET /v1/businesses/:id/generation-brief`):
    - page plan chips, locales, style and palette preview swatches;
    - selling points with evidence tooltips;
    - **warnings** (e.g. "No display-safe phone", "Few good images: stock/AI will be used");
    - overrides (locales, style, page plan from the catalog, extra instructions ≤ 500 chars) → `briefOverrides`.
  - **Settings**: auto-publish preview (default on), budget per item (advanced; defaults per engine), batch name.
  - **Estimate** panel: total typical cost (sum), ETA (from queue state and run mode), remaining monthly AI budget, and a warning or block when it would be exceeded (BF-013 soft/hard limits).
  - Submit with an `Idempotency-Key` (generated per sheet session), which prevents double submission. On success, navigate to the batch board.
- **Batch board** (`/generation/batches/[batchId]`):
  - Header:
    - name, status, overall progress, counts per status, total cost vs budget, elapsed time, ETA;
    - actions: cancel batch, add items (opens the sheet prefilled with the batch), duplicate batch.
  - Job cards in priority order, showing:
    - a status stepper (`queued → preparing → running → validating → repairing → succeeded | needs_review | failed | cancelled`);
    - engine badge with a failover history tooltip ("codex ✕ → blocks ✓");
    - progress %, elapsed, cost meter vs budget, attempt count;
    - the latest activity line (e.g. "sitekit validate → 2 issues").
  - When done, the card shows a screenshot thumbnail, the preview URL (copy/open/QR), a quality score badge, and quick actions: open editor (BF-037), send email (enabled when BF-052 lands), view quality.
  - Queued jobs: drag to reprioritize (calls the reorder API), "Start next", change engine.
  - Running jobs: cancel (with confirmation).
  - Terminal jobs: retry (choose engine), accept anyway (`needs_review` only, with a reason; disabled when facts/schema errors exist).
  - Live updates via org realtime (BF-012) with TanStack Query cache updates. Status changes are announced in an `aria-live="polite"` region (throttled), and the browser tab title shows progress.
- **Job console** (`/generation/jobs/[jobId]`, also openable as a side drawer from the board):
  - **Activity** tab:
    - SSE stream (`GET /v1/generation-jobs/:id/events`) with resume (`Last-Event-ID`), grouped by attempt;
    - event renderers per type: status, log, `tool_call` (icon per tool; e.g. Read/Edit/`sitekit validate` with an issue count), `file_change` (link to diff of `site.json` between checkpoints when available), screenshots inline (lightbox), usage (cost/tokens ticker), errors (typed with explanation and suggested action);
    - filters (tools/logs/errors), search, auto-scroll with "jump to latest", a virtualized list (10k events), rendering batched per animation frame.
  - **Quality** tab:
    - gate results with pass/fail, issues grouped by page/block (click → open editor focused on the block);
    - rubric scores (bar chart + table alternative);
    - screenshots (mobile/desktop), Lighthouse scores and auto-fixes applied.
  - **Brief** tab: the brief snapshot, facts used (table with provenance), assets chosen with licenses.
  - **Artifacts** tab (admins): download `site.json`, transcript (when collected), workspace bundle hash.
- **Generation home** (`/generation`):
  - Batches list (filters: status, creator, date; cursor pagination).
  - Engine status panel: per engine availability, running/queued for the workspace and globally, average duration and cost over 7 days.
  - **Needs review** queue: jobs in `needs_review` with top issues and quick actions.
- **Settings → Generation** (`settings:manage`; edits BF-039 `GenerationSettings`):
  - allowed engines (respects the `codingEngines` feature flag);
  - per-engine concurrency (input bounded by the global max shown);
  - default engine;
  - failover chain (sortable);
  - default budgets per engine;
  - auto-publish preview, default locales, default run mode;
  - engine assignment presets;
  - quality thresholds (tighten only, BF-045).
- **Business detail → Sites tab** (BF-024 registry):
  - the business's sites with current version, publication (URL, expiry, views), quality score and version history link;
  - Generate / Regenerate (opens the sheet with one item);
  - last generation jobs.
- Notifications deep links (batch completed, `needs_review`, failures) land on the right board or console.
- i18n EN/FR for all strings; empty, loading and error states; responsive (the board works on a tablet for demos with prospects).

**Out of scope**
- The editor (→ BF-037), chat editing (→ BF-047), email composer (→ BF-051/BF-052; the button is feature-detected).

## Requirements
### Functional
- Order in the sheet equals execution priority; reordering on the board changes the order of queued jobs (verified E2E with FakeEngine).
- "One by one" runs strictly sequentially; "In parallel" respects workspace and global limits (the UI explains when items wait for a slot).
- No double submissions (idempotency); reconnecting the console never shows gaps or duplicate events.
### Non-functional
- Board with 50 jobs and live updates stays smooth (< 16 ms frame budget on a mid-range laptop; profiling screenshot in the PR).
- Console handles 10k events without memory growth beyond 100 MB.

## Design
```
apps/web/src/features/generation/
├── create/{create-sites-sheet.tsx, items-list.tsx, engine-select.tsx, assign-engines-dialog.tsx,
│           run-mode.tsx, brief-preview.tsx, overrides-form.tsx, estimate-panel.tsx, use-create-batch.ts}
├── board/{batch-board.tsx, job-card.tsx, status-stepper.tsx, reorder.ts, batch-header.tsx}
├── console/{job-console.tsx, use-job-events.ts (SSE + resume), event-renderers/*, quality-tab.tsx,
│            brief-tab.tsx, artifacts-tab.tsx}
├── home/{generation-home.tsx, engines-panel.tsx, review-queue.tsx}
├── settings/{generation-settings.tsx, presets.tsx}
└── business-tab/{sites-tab.tsx}
apps/web/src/app/(dashboard)/generation/{page.tsx, batches/[batchId]/page.tsx, jobs/[jobId]/page.tsx}
```
- Patterns:
  - Container/presenter components.
  - Registry of event renderers (`EngineEvent` type → component).
  - Optimistic updates with rollback (reorder, cancel).
  - SSE resume with an event-id cursor.
  - URL state with nuqs (filters, open drawer).

## Implementation plan
1. API client hooks (generated client + TanStack Query): engines, batches, jobs, brief preview, settings.
2. Create sheet: items/order, engine select, assign helper, run mode, brief preview/overrides, estimate, submit.
3. Batch board with realtime updates, reorder/cancel/retry/accept, notifications deep links.
4. Job console with SSE resume, event renderers, quality/brief/artifacts tabs.
5. Generation home, review queue, settings page, business Sites tab.
6. Accessibility pass, i18n, performance profiling; E2E with FakeEngine (`GENERATION_FAKE_ENGINE=true`).

## Testing
- **Component:** engine select states (available/disabled with reason/load), assign-engines distribution ("2 Claude Code + 2 Codex + rest Blocks" for 6 items), estimate computation display, event renderers (snapshot per event type), status stepper transitions.
- **E2E** (Playwright, FakeEngine with scripted durations):
  - select 3 businesses → order café first → run mode one by one → café runs first, then the others in order → previews appear with URLs;
  - parallel mode with 2 FakeEngine-as-Claude-Code + 2 FakeEngine-as-Codex: at most 4 concurrent;
  - reorder a queued job → it starts next;
  - cancel a running job → cancelled within 10 s;
  - `needs_review` → accept anyway with a reason → published;
  - console reload mid-run resumes without gaps.
- **Accessibility:** axe on sheet, board and console; keyboard-only reorder and actions; live region announcements.

## Acceptance criteria
- [x] "Create sites" from selection with per-item order (priority), engine choice (availability/cost/time/load), assignment presets, one-by-one vs parallel, brief preview/overrides and estimate.
- [x] Live batch board with reorder, start next, cancel, retry, accept anyway, results (preview URL, screenshot, quality).
- [x] Job console streaming agent activity with resume; quality, brief and artifacts tabs.
- [x] Generation home with engines panel and needs-review queue; generation settings; business Sites tab.
- [ ] E2E, accessibility and performance checks pass; EN/FR. *(EN/FR done; tests paused 2026-10-17, see QUESTIONS.md "Testing paused")*

## Agent prompt
```text
Implement BF-046 (Generation UI).

Read first: AGENTS.md, docs/PRD.md (J3), docs/conventions/coding-standards.md (web), BF-039 (APIs, events, SSE,
settings, concurrency semantics), BF-040 (brief preview, briefOverrides), BF-045 (quality report, accept/repair APIs),
BF-023/BF-024 (selection, registries), BF-012 (realtime). Reuse @bf/ui (BF-007) components.

Rules:
- The UI reflects the backend's truth: priorities, concurrency and statuses come from the API/realtime; never
  simulate progress client-side.
- Make long-running parallel work calm: clear status steppers, honest ETAs, explicit reasons when items wait.
- SSE consumption must resume without gaps/duplicates; event lists are virtualized.
- Every action is accessible by keyboard; status changes announced politely; EN/FR strings.

Verify: pnpm verify && pnpm e2e (generation suite with FakeEngine); attach screenshots (EN/FR) of the sheet, board and
console, and a performance profile of the board with 50 jobs.
```

## References
- docs/PRD.md J3 · BF-039 · BF-040 · BF-045
- dnd-kit (sortable, keyboard sensors): https://docs.dndkit.com/ · TanStack Virtual: https://tanstack.com/virtual/latest · MDN Server-sent events: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
