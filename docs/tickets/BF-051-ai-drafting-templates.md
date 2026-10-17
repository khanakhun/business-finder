---
id: BF-051
title: AI email drafting and templates — grounded personalization, subject variants, recipient language, composer UI
milestone: M4 Reach
epic: outreach
type: feature
priority: P0
size: L
depends_on: [BF-013, BF-024, BF-030, BF-035, BF-040, BF-049, BF-050]
blocks: [BF-052, BF-053, BF-054, BF-057]
areas: [api, web, ai]
---

# BF-051 — AI email drafting and templates: grounded personalization, subject variants, recipient language, composer UI

## Context
A cold email works when it is **short, specific and honest**: it names something real about the business, shows proof (the preview website we built for them), and asks for little. Examples of real, specific details: "your site doesn't open on mobile", "customers mention they can't book online". The partner must be able to produce such emails in one click, in French or English, grounded in facts we can prove ([PRD J4, FR-52](../PRD.md#66-outreach)). AI writes the personalized part; deterministic code adds the mandatory compliance elements (footer, identity, address, source disclosure, unsubscribe) at send time (BF-052), so the model can never omit them.

Inputs already exist:
- display-safe facts (BF-040) and audit findings we measured (BF-030);
- review themes (BF-029, general terms only, never quotes);
- the preview site URL and views (BF-035/BF-036);
- contacts with classification (BF-028) and compliance decisions (BF-049);
- mailbox identity and signature (BF-050).

## Goal
Typed templates with variables and lint, a grounded `email-draft` AI task (subject variants, body, facts used, claims check), recipient-language selection, drafts persisted and editable, a final-rendering preview including the footer, and a composer UI usable from the listing row and the business page. Evals with thresholds are included.

## Scope
**In scope**
- **Tables**:
  - `email_templates`: `id`, `organization_id`, `name`, `purpose` (`first_touch|follow_up|breakup|reply`), `offer`, `locale`, `version`, `subject_variants` text[], `body_md`, `variables` jsonb (declared variable names → types), `status` (`active|archived`), `created_by`, timestamps. Immutable versions; the latest active version is used.
  - `email_drafts`:
    - `id`, `organization_id`, `business_id`, `contact_id`, `mailbox_id?`, `template_id?`, `template_version?`, `purpose`, `offer`, `locale`;
    - `subject`, `subject_variants` text[], `body_md`;
    - `facts_used` jsonb, `claims` jsonb, `lint` jsonb;
    - `generated_by` (`ai|template|human`), `ai_meta` jsonb (model, prompt version, cost, instructions);
    - `site_id?`, `compliance_preview` jsonb (non-binding snapshot);
    - `status` (`draft|discarded|sent_as_message`), `created_by`, timestamps.
- **Variables and rendering**:
  - Typed variable registry, Zod-defined, each with a resolver from domain data:
    - `business.name`, `business.locality`, `business.category`;
    - `contact.firstName?`, `contact.isGeneric`;
    - `preview.url`, `preview.expiresAt`;
    - `audit.topFindings[]` (localized phrases from BF-030 findings with severity);
    - `audit.mobileScore`;
    - `reviews.topTheme?` (general phrasing, no quotes);
    - `sender.firstName`, `sender.agencyName`;
    - `offer.label`.
  - Missing required variables block rendering with explicit errors. Optional sections use `{{#if}}` (logic-less templates: Handlebars or Mustache subset; no arbitrary code).
  - **Renderer**: markdown → `text/plain` (canonical) + minimal HTML alternative (no images, no tracking pixels, at most two links: the preview URL and the agency website), mailbox signature appended.
  - `EmailPreviewService.render(draft, { includeFooter: true })` shows the final message exactly as BF-052 will compose it. It uses a shared `FooterComposer` from the compliance required elements (BF-049). **BF-052 must use the same composer.**
- **AI task** `email-draft.v1` (smart tier; structured output):
  - **Inputs**:
    - business summary + display facts table (ids);
    - audit findings (ids, severity, metric values);
    - review themes (ids, counts);
    - preview site info (URL, pages, highlights);
    - offer;
    - recipient (generic vs named, role if known);
    - language and formality (FR: *vous*);
    - purpose;
    - optional template (the AI fills or adapts its slots);
    - operator instructions (≤ 300 chars).
  - **Output**: `subjectVariants[3]`, `body` (≤ 120 words for first touch; ≤ 80 for follow-ups), `factsUsed[]`, `findingsUsed[]`, `claims[]` (each with supporting ids), `personalizationRationale`.
  - **Rules in the prompt, enforced by validators**:
    - no invented facts or numbers (literal detection against facts/findings);
    - no fake familiarity ("I was a customer…"), fake urgency or false scarcity;
    - no "Re:"/"Fwd:" on first touch, no clickbait;
    - truthful subject;
    - no compliance footer text in the body (it is appended deterministically);
    - mention the preview as a *concept* built for them, not a finished product;
    - no criticism that sounds insulting (findings phrased constructively);
    - FR typography and natural EN.
  - **Validators**: fact/finding id existence, literal match, link policy, spam-trigger lint (data-driven FR/EN lists: excessive caps, "100% gratuit", "urgent", too many exclamation marks), length, reading level, and claims (reuse BF-045 `unsupported-claims` logic in email mode).
  - One repair attempt with validator messages, then a typed failure (the user sees what failed and can edit manually).
- **Recipient language policy** (pure): contact language → business site primary language (BF-026) → jurisdiction default (BL/FR/MF → `fr`, US/GB → `en`) → workspace default. The UI can switch it, and drafts in both languages can be generated on demand.
- **Seeded templates** (EN/FR, editable copies per workspace):
  - first touch with preview (website redesign / new website);
  - first touch without preview (audit-led);
  - follow-up 1 (gentle, adds one new detail);
  - follow-up 2 (polite close / "breakup");
  - reply templates for triage categories: price question, more information, not now, referral.
- **Template linting** (`POST /v1/templates/:id/lint` and on save): variable declarations vs usage, link policy, spam triggers, length, subject truthfulness heuristics (no "Re:"), placeholder leftovers.
- **APIs** (permission `outreach:send` to draft; templates need `settings:manage` or a new `templates:manage`):
  - `POST /v1/outreach/drafts` `{ businessId, contactId, offer, purpose, mode: 'ai'|'template', templateId?, locale?, instructions? }` → draft (streaming optional; P50 < 8 s for AI).
  - `GET/PATCH /v1/outreach/drafts/:id` (human edits are revalidated; facts lint warnings shown, not blocking for human-written text, except the link policy).
  - `POST /v1/outreach/drafts/:id/regenerate` (with instructions), `POST /v1/outreach/drafts/:id/translate`.
  - `GET /v1/outreach/drafts/:id/preview` (final rendering incl. footer + compliance preview).
  - `/v1/templates` CRUD + versions + lint.
- **Composer UI** (`features/outreach/composer/`; drawer from listing rows, business page, leads and inbox):
  - **Recipient** select: contacts with verification badges (BF-028) and the compliance panel (BF-049) showing the decision for this contact, reasons and alternatives. Blocked contacts are not selectable for email; alternatives are offered (call/WhatsApp assist via BF-057).
  - **Mailbox** select (default from `MailboxSelector`, with the reason shown), language toggle, offer, template picker.
  - **Generate / Regenerate** with quick instructions (shorter, more formal, mention the preview, focus on booking).
  - **Subject variant chips** (pick one or mark all for A/B in sequences).
  - **Editor**: markdown with variable chips and a facts-used side panel (hover shows sources/evidence), plus lint warnings inline.
  - **Live preview**: desktop/mobile/plain-text toggles, footer included, preview link card (screenshot from BF-035).
  - Actions: **Save draft**; **Send** (wired in BF-052: disabled with a tooltip until then); **Copy to clipboard** (manual sending path for `manual_only` decisions, logged as a manual action when the user confirms they sent it, via BF-052 manual log).
- **Evals** (`packages/ai/evals/email-draft/*.jsonl`, ≥ 50 cases FR/EN across categories, with and without preview, generic vs named recipients):
  - Metrics: facts/literal violations = 0; link policy violations = 0; spam lint warnings ≤ 1 average; length within bounds 100%.
  - Judge rubric ≥ 4.0/5 average: specificity, credibility, respectful tone, clarity of ask, language naturalness.
  - Report attached; nightly regression guard.

**Out of scope**
- Sending, outbox and headers (→ BF-052), sequences (→ BF-053), reply suggestions in the inbox (→ BF-054 reuses templates and the task in reply mode), tracking (opens/clicks are off by design).

## Requirements
### Functional
- No AI-generated body can include invented facts, extra links or compliance footer text (validators); the final rendering always includes the deterministic footer.
- Drafts never send by themselves; sending is a separate, gated action (BF-052).
- Language selection follows the policy and is visible and changeable.
### Non-functional
- AI draft P50 < 8 s, P95 < 15 s; average cost ≤ USD 0.02 per draft (measured).
- Composer usable with the keyboard; EN/FR UI strings.

## Design
```
packages/contracts/src/outreach/{template.ts, draft.ts, variables.ts}
apps/api/src/modules/outreach/
├── domain/drafting/{variables.ts, template.ts, language-policy.ts, link-policy.ts, spam-lint.ts}
├── application/drafting/{create-draft.ts, regenerate.ts, translate.ts, preview.ts, templates/*.ts}
├── infrastructure/drafting/{email-draft.task.ts, renderer/{markdown-to-text.ts, html.ts}, footer-composer.ts,
│                            seeds/templates/{en,fr}/*.md, lint-rules/{en,fr}.yaml}
└── interface/http/{drafts.controller.ts, templates.controller.ts}
packages/ai/prompts/email-draft.v1.md · packages/ai/evals/email-draft/*
apps/web/src/features/outreach/composer/{composer-drawer.tsx, recipient-select.tsx, mailbox-select.tsx,
  subject-variants.tsx, body-editor.tsx, facts-panel.tsx, email-preview.tsx, use-draft.ts}
apps/web/src/features/outreach/templates/{templates-page.tsx, template-editor.tsx}
```
- Patterns:
  - Template Method (render pipeline).
  - Strategy (language policy, AI vs template mode).
  - Specification (link/spam policies).
  - Shared kernel (`FooterComposer` used by preview and send).
  - Validator chain + single repair.

## Implementation plan
1. Contracts, variable registry and resolvers; template model, versions, lint; renderer + `FooterComposer` (with BF-049 required elements).
2. Language policy; seeded templates (EN/FR).
3. `email-draft` task + validators + repair; evals.
4. Drafts APIs (create/regenerate/translate/preview).
5. Composer UI + templates UI.
6. E2E; eval report.

## Testing
- **Unit:** variable resolution (missing/optional), link policy, spam lint FR/EN, language policy matrix, renderer (plain/HTML parity, signature, footer composition), template lint.
- **Integration** (fake LLM fixtures):
  - draft for a fixture business cites facts and findings;
  - a seeded hallucinated number triggers repair, then failure;
  - an extra link is rejected;
  - translation keeps facts;
  - preview includes the footer elements required by the compliance decision.
- **E2E:** open the composer from a listing row → generate FR draft → switch to EN → edit → preview shows the footer → save draft; a blocked contact shows alternatives.
- **Evals:** report attached.

## Acceptance criteria
- [x] Typed templates with variables, versions, lint and seeded EN/FR library.
- [x] Grounded `email-draft` task with subject variants, facts/findings citations, validators and repair.
- [ ] Evals pass thresholds (not done: the eval set is not written yet, testing is paused).
- [x] Recipient language policy; translation; final preview with deterministic footer shared with sending.
- [x] Drafts API and composer UI integrated in listing/business/leads with compliance and verification context.

## Agent prompt
```text
Implement BF-051 (AI email drafting and templates).

Read first: AGENTS.md, docs/compliance/outreach-compliance.md (§2 mandatory elements), docs/adr/0011 and 0012,
docs/conventions/ai-engineering.md (§5 facts, §6 untrusted data, §9 evals, §11 language), BF-040 (facts), BF-030
(findings), BF-049 (compliance decision, required elements, panel), BF-050 (mailbox identity/signature), BF-035
(preview URL/screenshots). Skim BF-052 (must reuse FooterComposer) and BF-053/BF-054 (template reuse).

Rules:
- AI writes the personalized body only; compliance elements are appended deterministically by shared code.
- Every specific claim cites facts/findings; literal numbers verified; only allowed links.
- Honest, respectful, short. French with "vous" and correct typography; natural American English.
- No tracking pixels or link tracking. Plain-text first.
- Evals are required; tune prompts with data.

Verify: pnpm verify && pnpm test:int && pnpm e2e (composer); pnpm eval --filter=@bf/ai -- email-draft (attach report).
```

## References
- docs/compliance/outreach-compliance.md §2 · ADR-0011 · ADR-0012 · BF-030 · BF-040 · BF-049
- M3AAWG sender best practices: https://www.m3aawg.org/published-documents · Google email sender guidelines: https://support.google.com/a/answer/81126
