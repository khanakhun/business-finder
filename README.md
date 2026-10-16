# Business Finder

> Find local businesses anywhere, understand which ones need help, generate a website preview for them in one click, and reach out (compliantly) with proof instead of a pitch.

Business Finder is an internal platform for a small web/AI agency. It is designed first for use in **Saint-Barthélemy (St Barts)** and the wider Caribbean, but it is location-agnostic: it works for any city, postcode, ZIP code or region worldwide.

```
 ┌────────┐   ┌──────────┐   ┌────────┐   ┌───────┐   ┌─────────────┐   ┌──────┐   ┌────────┐   ┌───────┐
 │  Find  │ → │  Enrich  │ → │ Audit  │ → │ Score │ → │ Build proof │ → │ Send │ → │ Triage │ → │ Learn │
 └────────┘   └──────────┘   └────────┘   └───────┘   └─────────────┘   └──────┘   └────────┘   └───────┘
  AI search    site intel,    PageSpeed,   explain-    AI-generated      one-click   AI reply     outcomes
  + providers  emails, socials vision grade able tiers  preview website   email,      triage,      retrain
                                                        on our domain     sequences   pipeline     the score
```

## What it does

| Capability | Summary |
|---|---|
| **Accounts & workspaces** | Email/password + OAuth, organizations (workspaces), roles, invitations, audit log. |
| **AI search** | Type *"hair salons and cafés in Gustavia with weak websites"*; the prompt is parsed into an editable structured search (category, area, filters), run against our listing or used to discover new businesses. |
| **Discovery** | Pluggable providers (Google Places API, Overture Maps, Foursquare OS Places, self-hosted Maps scraper) behind one interface; postcode/area tiling; entity resolution merges duplicates into one golden record. |
| **Listing** | Fast hybrid search (filters + full-text + semantic), facets, map view, saved searches, lists, pipeline (kanban), notes, tasks, activity timeline. |
| **Enrichment & audits** | Website crawl & extraction, tech stack, PageSpeed, screenshots graded by a vision model, email verification, review mining for pain points. |
| **Scoring** | Explainable, configurable scoring profiles per offer (new website, redesign, AI receptionist, …); later an outcome-trained model. |
| **Website builder** | Schema-driven multi-page sites (Home / About / Contact / Services …) rendered by our own multi-tenant host on our domain, editable in a visual editor (Puck), bilingual (FR/EN). |
| **One-click AI site generation** | Select businesses → *Create* → a prioritized queue builds sites in parallel with different engines (LLM composer, Claude Agent SDK, Claude Code, Codex), each in a sandbox, with quality gates and live logs. |
| **Outreach** | Connected mailboxes, AI-drafted personalized emails with the preview link, one-click send, sequences, reply triage, unsubscribe & suppression — every send passes a **compliance policy engine**. |
| **Analytics** | Funnel by niche/area/offer/engine/template, preview-site views, deliverability health. |

## Repository map

```
apps/
  web/            Next.js dashboard (App Router)                     → port 3000
  api/            NestJS modular monolith — HTTP + worker processes  → port 4000
  sites/          Next.js multi-tenant renderer for generated sites  → port 3100
services/
  intel/          Python (FastAPI) — crawling, extraction, open-data queries, ML
  agent-runner/   Sandbox image for coding agents (Claude Code, Codex, sitekit)
packages/         Shared TypeScript packages (@bf/*): contracts, db, auth, ai, ui,
                  site-schema, site-blocks, sitekit, email, queue, observability, …
infra/            Docker images, compose files, Caddy, deployment scripts
docs/             PRD, architecture, domain model, ADRs, conventions, tickets
```

> The code is built ticket by ticket. Until a ticket lands, its folder may not exist yet. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Documentation

| Doc | Purpose |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements: personas, journeys, functional & non-functional requirements |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, deployables, flows, data model, queues, AI and security design |
| [docs/DOMAIN.md](docs/DOMAIN.md) | Ubiquitous language, aggregates, state machines, domain events |
| [docs/adr/](docs/adr/) | Architecture Decision Records — *why* the stack looks the way it does |
| [docs/conventions/](docs/conventions/) | Coding, testing, API, security, AI-engineering and git conventions |
| [docs/compliance/outreach-compliance.md](docs/compliance/outreach-compliance.md) | Outreach rules by jurisdiction and the invariants the code enforces |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones, exit criteria, parallel work tracks |
| [docs/tickets/](docs/tickets/) | Every implementation ticket (mirrored as GitHub issues) |

## Building with AI coding agents

This repository is designed to be implemented by coding agents (Claude Code, Codex, …) one ticket at a time.

1. Read [AGENTS.md](AGENTS.md) (Claude Code also loads [CLAUDE.md](CLAUDE.md), which imports it).
2. Pick the lowest-numbered open ticket whose dependencies are merged — see [docs/tickets/README.md](docs/tickets/README.md).
3. In Claude Code run `/ticket BF-0NN`; in other agents paste the ticket's **Agent prompt** section.
4. The agent works on a branch `bf-0nn-short-slug`, keeps the PR focused, and runs `pnpm verify` before opening the PR.

Independent tracks (for example the website platform track `BF-033…BF-037` and the business-graph track `BF-014…BF-017`) can be built in parallel by separate agents using git worktrees. The [roadmap](docs/ROADMAP.md#parallel-work-with-several-agents) proposes five lanes; the [waves table](docs/tickets/README.md#waves-what-can-run-in-parallel) shows what can run at the same time.

## Quick start

Requirements: **Node.js 24** (see `.nvmrc`) with corepack. Nothing else needs a global install.

```bash
corepack enable                      # provides the pnpm version pinned in package.json
pnpm install                         # also installs the git hooks (lefthook)
pnpm verify                          # lint + typecheck + unit tests across the workspace
```

| Command | What it does |
|---|---|
| `pnpm verify` | `turbo run lint typecheck test` — the gate every PR must pass |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | One stage of `verify` |
| `pnpm format` | Format and auto-fix with Biome |
| `pnpm build` | Build every workspace that has a `build` script |
| `pnpm clean` | Remove build outputs, caches and `node_modules` |

Commits must follow Conventional Commits; `feat`, `fix`, `refactor` and `perf` subjects must reference their ticket, e.g. `feat(repo): bootstrap toolchain (BF-001)`. The pre-commit hook formats staged files.

Coming with BF-002 (local infrastructure) and the app tickets:

```bash
cp .env.example .env                 # fill in API keys you have; everything else has local defaults
pnpm infra:up                        # postgres(+postgis+pgvector), valkey, minio, mailpit, …
pnpm db:migrate && pnpm db:seed
pnpm dev                             # web :3000, api :4000, sites :3100, intel :8000
```

## Status

Planning complete: **62 tickets** across 6 milestones. See the [ticket index, waves and dependency graph](docs/tickets/README.md) and the [roadmap](docs/ROADMAP.md). Implementation starts at [BF-001](docs/tickets/BF-001-monorepo-bootstrap.md).
