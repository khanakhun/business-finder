# ADR-0008: Global business graph with an org-scoped CRM layer

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-014, BF-016, BF-024

## Context

Business facts (existence, address, website, phones, reviews, audits) cost money and time to obtain and are the same for every workspace. Sales state (pipeline status, notes, owner, scores under a workspace's own profiles, outreach) is private to a workspace. We may later host several agencies on one deployment.

## Decision

- **Global graph** (no `organization_id`): `businesses`, `business_sources`, `business_contacts`, `business_categories`, `business_media`, `business_reviews`, `website_snapshots`, `website_audits`, `review_insights`, `categories`, `geo_areas`.
- **Org-scoped layer** (`organization_id` required): `org_businesses` (status, owner, tags, do-not-contact, cached score/tier), `notes`, `tasks`, `activities`, `lists`, `saved_searches`, `scoring_profiles`, `business_scores`, `sites*`, `generation_*`, `mailboxes`, `outbound_messages`, `sequence_*`, `suppressions` (workspace scope), `compliance_decisions`.
- A workspace "sees" a business once it is in its `org_businesses` (created by discovery, search interactions or manual add). Global facts are readable by any workspace that tracks the business.
- **Suppression scopes**: workspace suppression (default) and global suppression (unsubscribes requested via our platform's unsubscribe page are applied **globally** for safety — a person who opts out of one agency's emails sent through our infrastructure should not receive another's).
- Workspace-provided corrections to global facts are stored as `manual` source records with high priority in survivorship rules, attributed to the workspace (audit trail).

## Alternatives considered

| Option | Why not |
|---|---|
| Everything org-scoped | Duplicate enrichment cost and data per workspace; entity resolution done N times. |
| Everything global | Leaks one workspace's sales activity to others. |

## Consequences

- Positive: enrichment once, reuse everywhere; clean privacy boundary for sales data.
- Negative: queries join global and org tables — `org_businesses` carries denormalized sort keys (score, tier, last activity) to keep listing queries fast.
- Negative: global corrections need governance (audit log + per-source priority).
