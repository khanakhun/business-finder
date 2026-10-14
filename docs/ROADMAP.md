# Roadmap

Six milestones take Business Finder from an empty repository to a production system that finds businesses, builds preview websites with AI agents and reaches out compliantly. Every milestone ends with something the sales partner in Saint-Barthélemy can use on **staging** (available from M1).

The ticket graph (dependencies, waves, parallelism) is generated in [docs/tickets/README.md](tickets/README.md). This page explains the *why* and *when*: goals, exit criteria and how to split the work across parallel agents.

## Milestones at a glance

| Milestone | Tickets | Outcome |
|---|---|---|
| **M0 Foundations** | BF-001 … BF-009 | A monorepo where any agent can add a module with tests, contracts and CI in minutes |
| **M1 Find & List** | BF-010 … BF-025 | The partner signs in, types a prompt, discovers and browses deduplicated local businesses, and manages a pipeline |
| **M2 Understand** | BF-026 … BF-032 | Every business has website intelligence, audits, verified contacts, review insights and an explainable score |
| **M3 Build** | BF-033 … BF-048 | Select businesses → **Create sites** → AI engines (Blocks, Claude Agent SDK, Claude Code, Codex) build bilingual previews on our domain, in priority order or in parallel |
| **M4 Reach** | BF-049 … BF-057 | One-click, compliance-gated email with the preview link; follow-ups that stop on reply; inbox triage; unsubscribe/DSR; deliverability; call and WhatsApp assist |
| **M5 Learn & Scale** | BF-058 … BF-062 | Analytics, outcome-trained scoring, security hardening, production operations, live sites on custom domains |

## Exit criteria

A milestone is done when all its P0 tickets are merged and the demo below works on staging with realistic data (synthetic or the partner's real usage). P1/P2 tickets may slip into the next milestone without blocking it.

### M0 Foundations
- `pnpm install && pnpm infra:up && pnpm db:migrate && pnpm dev` starts web, api, worker and intel locally; health endpoints are green.
- The NestJS module template (hexagonal layers, Drizzle repository, Testcontainers test) and the Next.js shell exist and are used by a sample module.
- Contracts generate OpenAPI, the web client and Python models; CI runs lint, typecheck, unit and integration tests on every PR.

### M1 Find & List
- The partner signs in on staging (2FA available), creates a workspace and invites a colleague.
- Typing *"salons and cafés in Gustavia without a website"* shows editable intent chips (categories, area, filters). The search runs on the listing, and **Discover** queries providers over the Saint-Barthélemy area pack with live progress and a budget.
- Results are deduplicated golden records with provenance, shown in a table and a map with facets. The detail page supports pipeline status, owner, notes, tasks and activity.

### M2 Understand
- Discovered businesses are enriched automatically: website crawl (contacts, socials, tech, booking providers, "no solicitation" markers), PageSpeed and vision grade with findings, verified emails, and review pain signals where licensing allows.
- The listing sorts by offer score (*new website*, *redesign*, *AI receptionist*, …) with tier badges. The detail page explains each score in plain EN/FR, and an admin tunes a profile with a live preview.

### M3 Build
- From the listing, the partner selects a salon, a hardware store and a café. They click **Create sites**, set the café first, and choose *one by one* or *parallel*, with engines per item (e.g. 2 × Claude Code + 2 × Codex; Blocks for the rest).
- The batch board streams progress, agent activity, cost and screenshots. Each success publishes a bilingual preview at `https://<slug>.<sites-domain>` with banner, `noindex`, and claim/opt-out.
- Quality gates (schema, facts, claims, copy, accessibility, Lighthouse, visual critic) pass or send the job to *needs review*. No generated preview states a fact absent from the fact registry.
- The partner edits a preview in the visual editor or by chat. A claim from the preview creates a lead and moves the business to *Engaged*.
- An engine benchmark report compares quality, cost and time across the four engines.

### M4 Reach
- **Before any real outreach**:
  - the owner records the legal review of the FR/BL (and any other target) policies in Settings → Compliance;
  - mailbox domains pass SPF/DKIM/DMARC checks;
  - the workspace postal address is set;
  - the unsubscribe endpoint is live on HTTPS.
- On a high-score business, **Send email** produces a grounded FR/EN draft with the preview link. The compliance panel shows *allowed with conditions* and why. One click sends from a connected mailbox with footer and RFC 8058 headers; undo works.
- A follow-up sequence is attached. A reply stops it within minutes, is triaged (*interested*) in the inbox with a suggested answer, and the business moves to *Engaged*.
- Unsubscribe (one click or by reply) suppresses across all mailboxes and sequences immediately. A DSR access export works.
- Call assist gives a script and best time to call. WhatsApp assist opens `wa.me` with a short personal message. Outcomes update the CRM.

### M5 Learn & Scale
- Analytics shows the funnel by niche, area, tier, template and engine, plus preview engagement and cost per lead.
- RLS is enforced on all org-scoped tables with cross-tenant tests. The threat model and the ASVS checklist are complete.
- Production runs by digest with health-gated deploys, PITR backups and a passing restore drill, dashboards and alerts.
- A claimed preview goes live on the client's domain with legal pages and verified contact routing. The client sees stats in the portal.
- Once enough outcomes exist (≥ 300 contacts, ≥ 30 positives), the outcome model trains and runs in shadow mode next to the rule-based profile.

## Parallel work with several agents

Use one git worktree and compose namespace per agent ([git-workflow.md](conventions/git-workflow.md#parallel-agents-with-worktrees)). An agent takes the lowest-numbered ticket in its lane whose `depends_on` are merged (GitHub label `agent:ready`). Recommended lanes for 3–5 agents:

| Lane | Focus | Ticket order |
|---|---|---|
| **A — Platform** | Core backend, identity, events, deploys | BF-001 → BF-002 → BF-003 → BF-006 → BF-007 → BF-010 → BF-011 → BF-012 → BF-025 → BF-035 → BF-039 → BF-043 → BF-060 → BF-061 |
| **B — Contracts, AI and search** | Contracts, observability, CI, LLM gateway, intent, hybrid search | BF-004 → BF-005 → BF-009 → BF-013 → BF-015 → BF-021 → BF-022 → BF-023 → BF-024 → BF-031 → BF-032 → BF-058 → BF-059 |
| **C — Intelligence and discovery** | Python intel, graph, providers, enrichment | BF-008 → BF-026 → BF-014 → BF-016 → BF-017 → BF-018 → BF-019 → BF-020 → BF-027 → BF-028 → BF-029 → BF-030 |
| **D — Website platform** | SiteSpec, blocks, sitekit, renderer, editor, assets, leads, live sites | BF-033 → BF-034 → BF-042 → BF-036 → BF-037 → BF-038 → BF-048 → BF-047 → BF-062 |
| **E — Generation and outreach** | Brief, engines, quality, generation UI, then the M4 outreach stack | BF-040 → BF-041 → BF-044 → BF-045 → BF-046 → BF-050 → BF-049 → BF-055 → BF-051 → BF-052 → BF-054 → BF-053 → BF-056 → BF-057 |

Notes:
- **Lane D starts early.** BF-033 depends only on contracts (BF-004), so the website platform can be built during M0/M1 by a dedicated agent. BF-035 (sites domain service) needs the API skeleton and events, so lane A or D picks it up when BF-012 and BF-014 are merged.
- **Pull-forward candidates.** BF-026 (website intelligence) can start right after BF-008. BF-050 (mailboxes) can start once BF-012 is merged, long before the rest of M4.
- **Shared hot spots.** `@bf/contracts`, the Drizzle schema and the NestJS app module change in many tickets. Keep PRs small, rebase often, and let the agent that adds a contract own its first consumer.
- **Coding-agent engines need infrastructure.** BF-043/BF-044 require Docker on the worker host and model API keys with budgets. Run them on staging before enabling them for the partner (feature flag `codingEngines`).

## Risk checkpoints

| When | Check | Why |
|---|---|---|
| End of M1 | Provider costs per discovery run and Saint-Barthélemy coverage (Google vs open data) | Decide provider preference order and budgets before enrichment multiplies calls |
| Mid M3 | Engine benchmark (BF-044): quality vs cost vs time | Set defaults (`auto` policy) and budgets; drop or demote engines that don't pay off |
| Before first real email (M4) | Legal review recorded, DNS auth green, unsubscribe live, postal address set, sends start manual-only with low caps | Protect the agency's legal standing and sending reputation |
| After ~300 contacts (M5) | Scoring validation by tier/decile (BF-058) | Decide whether to train the outcome model (BF-059) or adjust rules |

## Out of scope for v1

- Public self-serve SaaS signup and billing (assessment in BF-062).
- Domain purchase and email hosting for clients.
- Automated WhatsApp/SMS campaigns (manual assist only).
- Email open and click tracking (preview views on our own domain are used instead).
