---
id: BF-058
title: Analytics — funnel and conversion by niche, area, offer, tier, template and engine; preview engagement; unit economics
milestone: M5 Learn & Scale
epic: analytics
type: feature
priority: P1
size: L
depends_on: [BF-012, BF-031, BF-039, BF-045, BF-048, BF-052, BF-053, BF-054]
blocks: [BF-059]
areas: [api, web, db]
---

# BF-058 — Analytics: funnel and conversion by niche, area, offer, tier, template and engine; preview engagement; unit economics

## Context
After a few weeks of use, the agency needs answers to several questions:
- Which niches and areas respond?
- Do A-tier businesses really convert better?
- Which template, subject line or engine produces replies?
- Do prospects open the previews?
- What does a lead cost (LLM, sandboxes, images, provider calls)?

The answers come from [PRD FR-60](../PRD.md#67-analytics) and the success metrics in PRD §8. All the raw facts already exist as domain events and tables:
- discovery and enrichment;
- scores with feature snapshots (BF-031);
- generation jobs with quality and cost (BF-039/BF-045);
- site views (BF-035);
- leads (BF-048);
- outbound, inbound and triage (BF-052/BF-054);
- sequences and variants (BF-053);
- LLM and provider cost ledgers (BF-013/BF-018).

This ticket builds a consistent **metrics layer** (one definition per metric) and dashboards on top of it, without a separate data warehouse.

## Goal
A Postgres-native analytics module with:
- an append-only fact table fed by domain events;
- a semantic layer of named metrics and dimensions (YAML) compiled to SQL;
- materialized rollups refreshed incrementally;
- APIs and dashboards for funnel, cohorts, segments, experiments, preview engagement, engine comparison and unit economics, with CSV export and data-freshness indicators.

## Scope
**In scope**
- **Fact capture**: `analytics_facts` (append-only, partitioned by month):
  - `id`, `organization_id`, `occurred_at`, `event_type`, `business_id?`, `site_id?`, `job_id?`, `message_id?`, `enrollment_id?`, `lead_id?`;
  - dimensions snapshot (jsonb, also promoted to typed columns for hot dimensions): `category_path` (ltree), `area_id`, `country`, `offer`, `score_tier`, `score_value`, `profile_version`, `engine`, `template_id`, `template_version`, `variant_id`, `mailbox_id`, `locale`;
  - measures: `cost_usd`, `duration_ms`, `quality_score`, `count`.

  Populated by an outbox subscriber for the relevant events, using the DOMAIN §4 catalog: `business.created`, `score.updated`, `generation.job.status_changed`, `site.published`, `site.viewed`, `site.lead.captured`, `outreach.message.sent`/`bounced`, `outreach.reply.triaged`, `org_business.status_changed`, plus cost ledger entries.
  - Dimension snapshots are taken **at event time** (the tier when the email was sent matters, not today's tier).
  - Idempotent on event id.
  - A backfill command (`pnpm analytics:backfill --since`) rebuilds facts from source tables for existing data.
- **Semantic layer** (`apps/api/src/modules/analytics/semantic/*.yaml` + compiler):
  - **Dimensions**: time (day/week/month), category (taxonomy levels), area, country, offer, score tier, score bucket, engine, template, variant, mailbox, locale, pipeline stage, creator.
  - **Metrics** (single definitions, documented with formula and caveats):
    | Metric | Definition |
    |---|---|
    | `businesses_discovered` | count of `business.created` |
    | `businesses_contacted` | distinct businesses with ≥ 1 sent message or manual contact log |
    | `emails_sent`, `bounce_rate`, `unsubscribe_rate` | counts and rates over sent emails |
    | `reply_rate` | replied threads / contacted |
    | `positive_reply_rate` | `interested` + `question` / contacted |
    | `lead_rate` | site leads (claim/contact) / previews shared |
    | `meetings`, `won`, `win_rate` | from pipeline changes |
    | `previews_published`, `preview_view_rate` | share of shared previews with ≥ 1 attributed view; time to first view |
    | `generation_success_rate`, `needs_review_rate`, `avg_quality_score` | per engine |
    | `cost_per_site`, `cost_per_contact`, `cost_per_positive_reply`, `cost_per_lead` | LLM + sandbox compute estimate + image + provider costs |
    | `time_prompt_to_list`, `time_selection_to_preview` | PRD §8 success metrics |
  - The compiler generates parameterized SQL (no string concatenation of user input; dimension/metric names validated against the registry).
- **Rollups**: materialized views or rollup tables for daily aggregates per key dimension sets, refreshed every 15 minutes incrementally (watermark per rollup). Heavy cohort queries run on the facts table with indexes; a query timeout guard (10 s) with a friendly error.
- **APIs** (permission `analytics:read`, members and above; export needs `analytics:export`):
  - `POST /v1/analytics/query` `{ metrics[], dimensions[], filters, timeRange, granularity }`, validated against the semantic registry; result + `freshness`.
  - Prebuilt endpoints for dashboards (funnel, cohorts, experiments, engines, economics), cached with a short TTL.
  - `GET /v1/analytics/export.csv` (same query contract; audited).
- **Dashboards** (`/analytics`; Recharts, accessible table alternatives, EN/FR, URL-state filters):
  1. **Overview**: KPI cards with trends (contacted, positive reply rate, leads, won, cost per lead) and success-metric targets from PRD §8.
  2. **Funnel**: discovered → qualified → preview built → contacted → replied → positive → meeting → won, with conversion rates and drop-offs, segmentable by dimension. Cohort view by week of first contact.
  3. **Segments**: heatmap of category × area (positive reply rate with sample size), map of areas (MapLibre choropleth with Saint-Barthélemy quarters / areas from BF-017).
  4. **Scoring validation**: conversion by score tier and score decile (lift chart), so the partner can see whether A-tier really outperforms. Feeds BF-059.
  5. **Experiments**: template and variant comparisons with Wilson intervals and minimum-sample warnings. No automatic winner.
  6. **Engines**: per engine success rate, average quality score, time, cost, `needs_review` rate, **acceptance rate** (sent without manual edits), and downstream positive reply rate of emails linking to that engine's previews.
  7. **Preview engagement**: views over time, time-to-first-view after send, views per page, claims per view.
  8. **Unit economics**: spend by category (LLM by feature, sandboxes, images, providers) vs budget; cost per site, contact, positive reply and lead; trends.
- **Freshness and correctness**: every response includes the data watermark. A nightly reconciliation job compares facts counts with source tables for key metrics (sent emails, leads, jobs) and alerts on > 1% drift.
- **Privacy**: analytics stores no personal data (no emails, names or IPs); business-level ids only; retention per BF-055 (facts kept 36 months, then aggregated).

**Out of scope**
- External BI tools (Metabase/Superset can be pointed at a read replica later; documented), predictive modelling (→ BF-059), cross-workspace benchmarks.

## Requirements
### Functional
- Each metric has exactly one definition (semantic layer) used by every dashboard and export; definitions are documented and visible in the UI ("ⓘ How is this calculated?").
- Dimension values are snapshotted at event time.
- Experiments show uncertainty and sample sizes; no misleading percentages on tiny samples (n < 30 → muted with a warning).
### Non-functional
- Dashboard queries P95 < 1.5 s on 1M facts (benchmark with synthetic data).
- Facts ingestion keeps up with the event rate with < 2 min lag.

## Design
```
apps/api/src/modules/analytics/
├── domain/{metric.ts, dimension.ts, query-spec.ts, stats/{wilson.ts, lift.ts}}
├── semantic/{metrics.yaml, dimensions.yaml}
├── application/{ingest-fact.ts (subscriber), query.ts, export.ts, backfill.ts, reconcile.ts}
├── infrastructure/{compiler/sql-compiler.ts, rollups/*.sql, repositories/*, processors/{refresh.processor.ts,
│                   reconcile.processor.ts}}
└── interface/http/{analytics.controller.ts}
apps/web/src/features/analytics/{overview.tsx, funnel.tsx, cohorts.tsx, segments.tsx, scoring-validation.tsx,
                                 experiments.tsx, engines.tsx, previews.tsx, economics.tsx, metric-info.tsx}
```
- Patterns:
  - Event-sourced read model (facts from the outbox).
  - Semantic layer / Interpreter (YAML → SQL).
  - Materialized rollups with watermarks.
  - Specification (query validation).
  - Strategy (statistics helpers).

## Implementation plan
1. Facts table (partitioned) + subscriber + dimension snapshots + backfill.
2. Semantic registry + SQL compiler (TDD: generated SQL snapshots + correctness on fixture data).
3. Rollups + refresh processor + freshness.
4. Query/export APIs with validation, caching and timeouts.
5. Dashboards one by one (overview, funnel, segments, scoring validation, experiments, engines, previews, economics).
6. Reconciliation job + alerts; performance benchmark on synthetic data; docs (metric glossary).

## Testing
- **Unit:** compiler (each metric × dimension combination produces valid SQL; injection attempts rejected), Wilson intervals, lift computation, dimension snapshot logic.
- **Integration:** seed a synthetic dataset covering the funnel and verify metric values against hand-computed expectations (golden numbers); backfill equals live ingestion; rollup refresh is incremental; reconciliation detects an injected drift.
- **Performance:** 1M-fact benchmark report.
- **E2E:** dashboards render with filters; the export CSV matches the on-screen table; metric info tooltips show definitions.

## Acceptance criteria
- [x] Append-only facts with event-time dimension snapshots, backfill and reconciliation.
- [x] Semantic layer with documented metrics/dimensions compiled to safe SQL; single source of truth.
- [x] Dashboards: overview, funnel/cohorts, segments (heatmap + map), scoring validation, experiments, engines, preview engagement, unit economics.
- [ ] Query and export APIs with freshness; performance targets met. (APIs and freshness done; the performance
  benchmark was not run while testing is paused.)

## Agent prompt
```text
Implement BF-058 (Analytics).

Read first: AGENTS.md, docs/PRD.md (§6.7, §8 success metrics), docs/DOMAIN.md §4 (events), docs/ARCHITECTURE.md §6,
BF-012 (outbox), BF-031 (score snapshots), BF-039/BF-045 (jobs, quality, cost), BF-035 (views), BF-048 (leads),
BF-052/BF-053/BF-054 (messages, variants, triage), BF-013 (LLM ledger). Skim BF-059 (consumes scoring validation).

Rules:
- One definition per metric (semantic layer); dashboards and exports use it exclusively.
- Snapshot dimensions at event time; never recompute history from current state.
- Honest statistics: sample sizes and intervals; mute tiny samples.
- No personal data in analytics. Parameterized SQL only.

Verify: pnpm verify && pnpm test:int && pnpm e2e (analytics); attach the performance benchmark and golden-number test summary.
```

## References
- docs/PRD.md §6.7, §8 · docs/DOMAIN.md §4
- PostgreSQL partitioning: https://www.postgresql.org/docs/current/ddl-partitioning.html · Materialized views: https://www.postgresql.org/docs/current/rules-materializedviews.html · Recharts: https://recharts.org/
