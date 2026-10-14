# Product Requirements Document — Business Finder

| | |
|---|---|
| Status | Approved for build (v1.0) |
| Owners | Agency partners (operator + sales partner) |
| Primary market | Saint-Barthélemy (BL) and the Caribbean; secondary: any city/region worldwide |
| Languages | Dashboard: English + French. Generated sites: French + English (bilingual by default for BL) |

---

## 1. Vision

Small web/AI agencies win clients by showing, not telling. Business Finder turns "find a lead → research it → build something for it → reach out" from a day of manual work per prospect into minutes, while keeping a human in control of every message and staying inside the rules for unsolicited communication.

## 2. Problem

- Finding the right local businesses by **niche + place** (a street, a postcode, an island) means juggling Google Maps, spreadsheets and guesswork.
- Knowing **which** businesses actually need help (no website, outdated site, booking friction, unreachable by phone) requires slow manual audits.
- Generic cold emails ("we build websites") are ignored. A **ready preview site built for that business** converts far better, but building one by hand per prospect doesn't scale.
- Outreach is legally different per country (opt-in vs opt-out, B2B exceptions). One mistake can burn a sending domain or bring a fine.

## 3. Goals and non-goals

### Goals (v1)
1. G1 — Discover and list businesses for any *prompt + area*, with deduplicated, enriched records.
2. G2 — Rank businesses with an explainable opportunity score per offer.
3. G3 — Generate a professional 2–4 page preview website for any selected business in one click, in parallel, on our own domain.
4. G4 — Send a personalized, compliant email (with the preview link) in one click; run follow-up sequences; triage replies.
5. G5 — Measure the funnel and learn which signals, templates and engines convert.

### Non-goals (v1)
- Public self-serve SaaS signup and billing (architecture keeps the door open; see BF-062).
- Automated LinkedIn or WhatsApp sending (manual assist only — platform rules and law).
- Bulk SMS / automated cold calling (telemarketing law; manual call assist only).
- Full CMS for clients to manage their own sites after purchase (handover is a later phase).

## 4. Personas

| Persona | Description | Top needs |
|---|---|---|
| **Sales partner (St Barts)** | Non-developer agency partner, knows the island's businesses, does calls and visits. Uses the dashboard daily, often on a laptop, sometimes on a phone. | Simple search in plain language, clear "who to contact next", one-click preview sites to show on calls, reliable email sending. |
| **Operator / developer** | Technical partner. Configures providers, keys, mailboxes, scoring, engines; also prospects in other markets (e.g. Netherlands, US). | Control and observability, cost tracking, engine choice, compliance per jurisdiction, extensibility. |
| **Prospect (business owner)** | Owner of a salon, café, hardware store, villa agency… Receives an email or a call, opens the preview link. | A credible, fast, bilingual preview of *their* business; an easy way to say "interested" or "stop". |

## 5. Key user journeys

**J1 — Find opportunities by prompt.** The partner types *"salons, spas and cafés in Gustavia and Saint-Jean with no website or a slow one"*. The system shows the parsed search (categories, area, filters) as editable chips, runs it on existing listings, and offers *"Discover more in this area"*, which runs providers, merges duplicates, enriches and scores new businesses, streaming progress.

**J2 — Qualify.** The partner sorts by *Website redesign* score, opens a business: sees the website screenshot, PageSpeed, vision grade ("looks dated: 3/10"), review pain points ("customers say they can't book online"), contacts (with verification status), and a plain-language *why this score* breakdown. They move it to *Qualified*.

**J3 — Generate previews in a batch.** The partner selects a salon, a hardware store and a café, clicks **Create sites**, sets priorities (café first), and chooses engines per item (Auto / Blocks / Claude Code / Codex / Claude Agent). The batch page shows each job live (queued → preparing → running → validating → published), with logs, cost and screenshots. Within minutes each business has a bilingual preview at `https://<slug>.<sites-domain>`.

**J4 — One-click outreach.** On a high-score business the partner clicks **Send email**. An AI draft appears (FR or EN by recipient), referencing real audit facts and the preview link; compliance shows *allowed* (and why) with required footer added automatically. One click sends it from a connected mailbox; a 2-step follow-up sequence is attached.

**J5 — Reply handling.** A reply arrives: triage labels it *Interested — asks for price*, stops the sequence, moves the business to *Engaged*, notifies the partner and proposes a reply draft.

**J6 — Prospect claims.** The prospect opens the preview, clicks *"This is my business — I'm interested"*, leaves a phone number; the lead appears instantly and the business moves to *Engaged*.

**J7 — Learn.** After a few hundred contacts the operator trains the outcome model and compares it to the rule-based profile in shadow mode before switching.

## 6. Functional requirements

Priority: **P0** = MVP-critical, **P1** = v1, **P2** = later. Ticket references in brackets.

### 6.1 Accounts & workspaces
- FR-1 (P0) Email/password sign-up/in with email verification; optional Google OAuth; TOTP 2FA. [BF-010]
- FR-2 (P0) Organizations (workspaces) with members and roles: owner, admin, member, viewer; invitations by email. [BF-010]
- FR-3 (P0) Workspace settings: agency identity (name, legal address, logo — used in email footers and preview banners), default languages, timezone. [BF-011]
- FR-4 (P0) Encrypted storage for provider keys and mailbox credentials; keys never shown after save. [BF-011]
- FR-5 (P1) Audit log of security-relevant and outbound actions. [BF-011]

### 6.2 Search & discovery
- FR-10 (P0) Natural-language search parsed into a structured, editable search intent (categories from our taxonomy, area, filters, mode). Supports EN and FR prompts. [BF-021]
- FR-11 (P0) Area resolution from free text: island, town, district, postcode (NL), ZIP (US), "within 5 km of …". [BF-017]
- FR-12 (P0) Discovery providers: Google Places API (P0), Overture Maps (P1), Foursquare OS Places (P1), self-hosted Maps scraper (P2, feature-flagged). [BF-018, BF-019]
- FR-13 (P0) Discovery runs with progress, cancellation, cost estimate and budget cap. [BF-020]
- FR-14 (P0) Entity resolution: one golden record per real business, with source provenance per field; manual merge/unmerge. [BF-016]
- FR-15 (P0) Category taxonomy (EN/FR labels) with provider mappings and AI fallback classification. [BF-015]

### 6.3 Listing & CRM
- FR-20 (P0) Hybrid search over listings: filters, full-text (accent-insensitive), fuzzy name, semantic; facets; map and table views; cursor pagination. [BF-022, BF-023]
- FR-21 (P0) Saved searches, lists, tags, bulk actions (add to list, tag, generate sites, enroll in sequence, export CSV). [BF-023]
- FR-22 (P0) Business detail with tabs: overview, website audit, reviews & pain signals, contacts, sites, outreach, activity. [BF-024]
- FR-23 (P0) Pipeline statuses with allowed transitions, owner, notes, tasks/reminders, kanban board. [BF-024]
- FR-24 (P1) Notifications (in-app, email digest) for replies, leads, finished batches. [BF-012]

### 6.4 Enrichment, audits & scoring
- FR-30 (P0) Website intelligence: crawl key pages, extract contacts, socials, structured data, booking/ordering tools, tech stack, language; desktop+mobile screenshots. [BF-026]
- FR-31 (P0) PageSpeed (mobile/desktop) and a vision-model UX grade with findings. [BF-030]
- FR-32 (P0) Email discovery and verification with status (valid, invalid, catch-all, risky, unknown). [BF-028]
- FR-33 (P1) Review mining into a fixed pain-point taxonomy with short evidence snippets. [BF-029]
- FR-34 (P0) Scoring profiles per offer (new website, redesign, AI receptionist, booking system, local SEO) with explainable breakdown and tiers A/B/C; recompute on data change. [BF-031, BF-032]
- FR-35 (P2) Outcome-trained model in shadow mode, then switchable per profile. [BF-059]

### 6.5 Website platform & AI generation
- FR-40 (P0) Sites are documents (`SiteSpec`) rendered by our multi-tenant host on `<slug>.<sites-domain>`; 2–6 pages; FR/EN; theme tokens; curated block library. [BF-033…BF-036]
- FR-41 (P0) Versioning: every generation/edit creates an immutable version; publish/rollback; previews auto-expire (default 30 days) unless extended. [BF-035]
- FR-42 (P0) Visual editor (Puck) for manual edits. [BF-037]
- FR-43 (P0) Batch generation from a selection with per-item priority and engine, configurable parallelism per engine, retries with engine failover, cancellation, budgets. [BF-039]
- FR-44 (P0) Engines: Blocks (LLM composer, default), Claude Agent SDK, Claude Code CLI, Codex CLI — all produce a `SiteSpec`; coding agents run in sandboxes. [BF-041…BF-044]
- FR-45 (P0) Quality gates: schema, fact-check against known business facts, copy checks, accessibility, Lighthouse, visual critic; failing jobs go to *needs review*. [BF-045]
- FR-46 (P1) Chat-to-edit a site ("make the hero warmer, add a menu page"). [BF-047]
- FR-47 (P0) Preview banner ("Concept preview by <agency>"), noindex, claim/interest form, cookieless view counting. [BF-036, BF-048]

### 6.6 Outreach
- FR-50 (P0) Jurisdiction-aware compliance engine; every send evaluated and logged; unknown jurisdiction defaults to *manual only*. [BF-049]
- FR-51 (P0) Mailboxes: Google Workspace, Microsoft 365, SMTP/IMAP; daily caps, ramp-up schedule, sending windows, rotation. [BF-050]
- FR-52 (P0) AI-drafted emails grounded in known facts, with subject variants, language by recipient, mandatory footer; templates with variables. [BF-051]
- FR-53 (P0) One-click send from row or detail page; bulk send with approval; outbox with idempotency; RFC 8058 one-click unsubscribe headers. [BF-052]
- FR-54 (P1) Sequences: steps, waits in business days, stop on reply/bounce/unsubscribe, A/B variants. [BF-053]
- FR-55 (P0) Reply ingestion, AI triage, unified inbox with suggested replies. [BF-054]
- FR-56 (P0) Unsubscribe page and suppression lists; data-subject request tooling; retention jobs. [BF-055]
- FR-57 (P1) Deliverability guardrails: auto-pause on bounce spikes, DNS auth checks, health dashboard. [BF-056]
- FR-58 (P1) Call & WhatsApp assist: scripts, click-to-call, `wa.me` links with prefilled text, outcome logging. [BF-057]

### 6.7 Analytics
- FR-60 (P1) Funnel and conversion by niche, area, offer, score tier, template, engine; preview views; cost per lead/site. [BF-058]

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Listing search p95 < 300 ms at 200k businesses; dashboard first load < 2.5 s LCP on broadband; generated sites ≥ 95 Lighthouse performance (mobile) for fixture sites. |
| Throughput | Discovery: ≥ 1,000 businesses ingested/hour on one worker; generation: configurable parallelism (default blocks 6, Claude Code 2, Codex 2). |
| Availability | Single-region deployment; target 99.5% monthly for dashboard/API; preview sites 99.9% (static-cacheable). |
| Durability | Daily full backups + WAL archiving (PITR 7 days); object storage versioning for assets. |
| Security | OWASP ASVS L2 subset; RBAC + org scoping on every query; encrypted secrets; SSRF guard; sandboxed agents; CSP on all apps. |
| Privacy | Data minimization (no reviewer names stored), provider retention rules enforced (e.g. Google Places content TTL), suppression honoured instantly, prospect data purge after inactivity (default 36 months). |
| Compliance | Policy engine per jurisdiction; every outbound message has a stored compliance decision and lawful-basis reference. |
| Cost | Every LLM/provider call is metered per org and feature; per-run budgets for discovery and generation; monthly budget alerts. |
| i18n | Dashboard EN/FR; generated sites FR/EN (more locales by config); dates/currency per locale. |
| Accessibility | Dashboard WCAG 2.1 AA for core flows; generated sites pass axe with zero serious/critical violations. |
| Observability | Structured logs, traces across api/worker/intel, LLM traces with cost, queue dashboards, alerts. |

## 8. Success metrics

- Time from prompt to qualified list of 20 businesses: < 10 minutes.
- Time from selection to published preview: median < 4 min (Blocks), < 15 min (coding agents).
- Generated preview acceptance (no manual edits needed before sending): ≥ 70%.
- Positive reply rate on emails with preview link: ≥ 3% (benchmark ~1% for generic cold email).
- Zero compliance incidents (sends without a stored allowed decision = 0).

## 9. Release plan

See [ROADMAP.md](ROADMAP.md): M0 Foundations → M1 Find & List → M2 Understand → M3 Build → M4 Reach → M5 Learn & Scale. A staging environment is available from M1 so the sales partner can test early.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Provider ToS (scraping, caching) | Prefer official APIs and open data; scraper behind a feature flag; per-provider retention TTL and purge job ([ADR-0013](adr/0013-discovery-providers-and-data-licensing.md)). |
| Low data coverage on small islands | Combine providers; manual add/edit of businesses; website crawl as a source. |
| Hallucinated facts in sites/emails | Fact registry; generation constrained to known facts; fact-check gate; human approval by default. |
| Prompt injection via crawled content | Untrusted-content wrapping, tool minimization, sandboxed agents, output validation. |
| Deliverability damage | Separate sending domains, caps and ramp-up, auto-pause, verification before send. |
| Legal exposure | Policy engine with conservative defaults; legal review flag on seeded policies; documentation of lawful basis. |
| Agent cost blow-ups | Per-job budgets and wall-time limits; cost dashboards; engine failover to cheaper engine. |

## 11. Open questions (tracked in tickets)

- Final sites domain and sending domains (config only; no code impact).
- Which mailbox providers the partners will use first (Google Workspace assumed).
- Legal confirmation of the seeded jurisdiction policies, especially Saint-Barthélemy (BL) — flagged `needs_legal_review`.
