---
id: BF-049
title: Compliance policy engine — jurisdiction policies, mandatory decision gate, suppression core, lawful basis, legal review
milestone: M4 Reach
epic: compliance
type: feature
priority: P0
size: L
depends_on: [BF-011, BF-012, BF-015, BF-017, BF-024, BF-026, BF-028]
blocks: [BF-051, BF-052, BF-053, BF-054, BF-055, BF-057]
areas: [api, db, contracts, web]
---

# BF-049 — Compliance policy engine: jurisdiction policies, mandatory decision gate, suppression core, lawful basis, legal review

## Context
Every outreach action must be legal where the recipient is, and explainable afterwards ([ADR-0012](../adr/0012-compliance-by-design-outreach.md), [outreach-compliance.md](../compliance/outreach-compliance.md)). Rules differ:
- **US** (CAN-SPAM): opt-out.
- **FR / BL / MF**: B2B opt-out if relevant to the profession, with information and an opt-out from the first message.
- **NL**: consent, unless the address was designated for such messages.
- **BE**: impersonal addresses of legal persons only.
- **DE**: consent.
- **GB**: corporate subscribers vs sole traders.
- **Unknown jurisdiction**: manual only.

The operator is EU-based, so GDPR-grade handling (legitimate-interest assessment, source disclosure, objection, minimization, retention) applies everywhere.

Inputs already exist:
- business location and areas (BF-017);
- contact classification and publication context (BF-028);
- "no solicitation" markers (BF-026);
- `do_not_contact` on org businesses (BF-024);
- workspace identity and postal address (BF-011).

This ticket builds the `compliance` module. Its centre is the **mandatory decision gate** that BF-052 (sending), BF-053 (sequences) and BF-057 (calls/WhatsApp) must call. This ticket also provides the **suppression core** that BF-028's pre-check port and BF-055's unsubscribe flows plug into.

> Not legal advice. Seeded policies ship with `needs_legal_review = true`; automatic sending for a jurisdiction is impossible until an owner records a review.

## Goal
A versioned, data-driven policy engine (typed rule DSL) with seeded jurisdiction policies per channel. It provides:
- conservative defaults and stricter-only workspace overrides;
- a fast `ComplianceService.evaluate()` returning persisted, explainable decisions, required message elements and compliant alternatives;
- append-only suppression with fast lookup;
- lawful-basis (LIA) records;
- a legal-review workflow in the UI that gates automatic sending per jurisdiction;
- architecture rules that make bypassing the gate impossible.

## Scope
**In scope**
- **Tables** (migration):
  - `compliance_policies`: `id`, `organization_id` (null = global seed), `jurisdiction` (ISO 3166-1 alpha-2 incl. `BL`, `MF`, or `*`), `channel` (`email|phone|whatsapp|sms|letter`), `version`, `rules` jsonb (DSL), `required_elements` jsonb, `sources` jsonb (URLs + titles), `needs_legal_review`, `reviewed_by?`, `reviewed_at?`, `review_notes?`, `kind` (`seed|override`), `created_at`. Versions are immutable; `compliance_policy_heads` maps (org | global, jurisdiction, channel) to the active version.
  - `compliance_decisions` (append-only): `id`, `organization_id`, `business_id`, `contact_id?`, `channel`, `purpose` (offer), `stage` (`enqueue|send|manual_log`), `decision`, `reasons` jsonb[] (`code`, `message`, `ruleRef`), `required_elements` jsonb, `alternatives` jsonb, `inputs` jsonb (full snapshot), `policy_version_ids` uuid[], `lawful_basis_id?`, `outbound_message_id?`, `evaluated_at`, `valid_until`.
  - `suppression_entries` (append-only): `id`, `organization_id` (null = global), `scope` (`email|domain|phone|business|org_business`), `value_normalized`, `action` (`add|revoke`), `reason` (`unsubscribe|opt_out|complaint|hard_bounce|manual|dsr_objection|no_solicitation|legal`), `source` (`link|one_click|reply|site_form|api|import|admin|system`), `actor` jsonb, `note?`, `created_at`. View/materialized table `suppressions_current` (latest action per key = add) with a unique index on (`org`, `scope`, `value_normalized`) for O(log n) lookup; Valkey cache for hot keys with invalidation on write.
  - `lawful_basis_records`: `id`, `organization_id`, `kind` (`legitimate_interest_assessment|consent|other`), `title`, `purpose`, `data_categories`, `necessity`, `balancing_test`, `safeguards`, `retention`, `version`, `status` (`draft|approved|retired`), `approved_by?`, `approved_at?`, `document_md`, timestamps. A default LIA template (EN/FR) for B2B website-services prospecting is seeded as a draft.
  - `offer_relevance`: `offer`, `taxonomy_prefix` (ltree), `relevant` bool, `rationale` (EN/FR), seeded. Example: `new_website`/`website_redesign` relevant to all customer-facing categories; `ai_receptionist` relevant to categories that take bookings or calls.
- **Rule DSL** (`@bf/contracts/compliance`, Zod; human-renderable):
  - Policy shape: `{ default, rules: Rule[], requiredElements, markers }`, where a `Rule` is `{ id, when: Conditions, then: Decision, conditions?: Condition[], explain: LocalizedText }` and the first match wins.
  - Condition keys:
    - `recipientType` (`legal_person|sole_trader|public_body|unknown`);
    - `addressType` (`generic|department|personal|unknown`);
    - `publishedContext` (`own_contact_page|own_site_other|directory|unknown`);
    - `designatedForSolicitation` (bool|unknown);
    - `verification` (status set);
    - `hasNoSolicitationMarker`;
    - `relevance` (`relevant|not_relevant|unknown`);
    - `previousContact` (none|replied|bounced).
  - Global **overlays** applied after the jurisdiction rule. The **most restrictive** result wins (lattice `allowed < allowed_with_conditions < manual_only < blocked`):
    - suppression hit → `blocked`;
    - `do_not_contact` → `blocked`;
    - no-solicitation marker → `blocked` for email/SMS/WhatsApp automation and `manual_only` with a warning for calls;
    - invalid or disposable address → `blocked`;
    - offer not relevant → `blocked`;
    - workspace not outreach-ready (missing agency name or postal address, BF-011 readiness) → `blocked` with the reason "complete workspace identity";
    - no approved lawful-basis record for the purpose → `manual_only`.
  - **Stricter-only merge**: a workspace override is applied as `max(seedDecision, overrideDecision)` per input, so overrides can never loosen a seed (property-tested).
- **Seeded policies** for `US`, `FR`, `BL`, `MF`, `NL`, `BE`, `DE`, `GB` and `*`, per channel (email, phone, whatsapp, sms, letter), transcribed from [outreach-compliance.md](../compliance/outreach-compliance.md) with sources. All have `needs_legal_review = true`.
  - BL mirrors FR, with a note.
  - WhatsApp defaults to `manual_only` (human-initiated click-to-chat with identification and stop on request; automated business-initiated WhatsApp messaging is out of scope).
  - SMS defaults to `manual_only` or `blocked` per jurisdiction.
  - Seeds are loaded by migration, so they are versioned in git.
- **Resolvers** (ports + adapters):
  - `JurisdictionResolver`:
    1. business location country from the golden record and areas (BL/MF via ISO code, postcode 97133 for BL, or polygon);
    2. otherwise the phone country code;
    3. otherwise the contact domain ccTLD;
    4. conflicting signals → evaluate all candidates and take the **stricter** result;
    5. unknown → `*`.
  - `RecipientTypeResolver`: port with adapters:
    - **FR/BL/MF**: the public company search API (`recherche-entreprises.api.gouv.fr`, no key; verify the current endpoint and terms) matched by name + postcode, mapping the legal-form code to legal person vs sole trader (entrepreneur individuel);
    - **GB**: Companies House (API key; optional);
    - everyone else: `unknown`.

    Results are cached on the business with provenance (90-day TTL).
  - `AddressContextResolver` from BF-028 classification and published context. `designatedForSolicitation` stays `unknown` unless a human marks it, with evidence (needed for NL).
- **`ComplianceService`** (application service; the only public entry point):
  - `evaluate(target, channel, context)`, with `target = { orgId, businessId, contactId? | address? }` and `context = { purpose (offer), stage, lawfulBasisId?, campaignId? }`, returns a `ComplianceDecision`:
    - decision, reasons (localized EN/FR, ordered), required elements (identity, postal address, opt-out link + headers, source disclosure line with the source URL, language);
    - **alternatives** when not allowed (e.g. "Call (manual, allowed with right to object)", "Send manually from your mailbox after confirming consent", "Postal letter");
    - `validUntil` (enqueue decisions valid 24 h; send-stage decisions are point-in-time).
  - Persists decisions for `enqueue`, `send` and `manual_log` stages; `preview` (UI) decisions are computed and not persisted (rate-limited).
  - `isAutoSendPermitted(orgId, jurisdiction, channel)`: true only if the effective policy version has a recorded legal review **and** the workspace enabled auto-send (`outreach:auto_send` permission holder action). Used by BF-052/BF-053.
  - `suppress(entry)`, `revokeSuppression(key, reason, actor)` (admins only; audited), `isSuppressed(keys[])` (batch). Implements the BF-028 suppression pre-check port.
  - Emits `contact.suppressed` (DOMAIN §4) on suppression adds.
  - Subscribes to `site.opt_out.requested` (BF-048) and creates a suppression (scope `org_business`; plus `email` when known).
- **Enforcement**:
  - **Architecture rules** (dependency-cruiser or Biome plugin + test): only `apps/api/src/modules/outreach/infrastructure/sending/**` may import mailbox provider adapters' send capability; no module may write `outbound_messages.status = 'queued'` except the outreach domain service, which requires a decision id.
  - The rule config and a failing-fixture test are added now; BF-050/BF-052 code must comply.
  - Typed `ComplianceDecisionId` branded type required by the outbound domain constructor (compile-time guard).
- **APIs** (permissions: `compliance:manage` for policy, review and overrides; `outreach:send` for evaluate; `business:read` for decision history):
  - `POST /v1/compliance/evaluate` (preview for the UI: business/contact/channel/offer → decision + reasons + elements + alternatives).
  - `GET /v1/compliance/policies` (effective per jurisdiction/channel with review status), `GET /v1/compliance/policies/:jurisdiction/:channel/versions`.
  - `POST /v1/compliance/policies/:id/review` (reviewer name, notes, confirmation checkbox "I have verified this policy with qualified advice"; audit logged).
  - `POST /v1/compliance/overrides` (validated stricter-only; preview of affected decisions).
  - `GET /v1/compliance/decisions?businessId=&messageId=` (history with inputs).
  - `GET/POST /v1/suppressions`, `POST /v1/suppressions/check`, `POST /v1/suppressions/:id/revoke` (core; full UI, import and export in BF-055).
  - `GET/POST/PATCH /v1/compliance/lawful-basis` + `POST …/:id/approve`.
- **UI** (Settings → Compliance, `compliance:manage`):
  - **Policies**: a matrix of jurisdictions × channels with decision defaults and review badges, a rule viewer (DSL rendered as readable sentences EN/FR with sources), the review dialog, and an override editor (stricter-only, with an impact preview).
  - **Lawful basis**: LIA editor from the template, approve and retire.
  - **Compliance panel component** for other features (BF-051/BF-052/BF-057): decision badge, reasons, required elements checklist, alternatives. Exported from `features/compliance/`.
  - Business detail: "Compliance" section showing the current evaluation per channel and the decision history.
- **Observability**:
  - Metrics: decisions by outcome, jurisdiction and reason; evaluate latency; suppression hits.
  - An alert if any `sent` message lacks a decision (should be impossible; a check query runs hourly).

**Out of scope**
- Unsubscribe pages/links/headers and reply-based unsubscribe (→ BF-055), the sending pipeline (→ BF-052), DSR tooling and retention (→ BF-055), deliverability rules (→ BF-056).

## Requirements
### Functional
- Unknown jurisdiction gives `manual_only`. A missing postal address blocks email. Overrides are stricter only. Unreviewed policies never allow automatic sending.
- Every enqueue/send decision is persisted with full inputs and policy versions and can be explained in EN/FR.
- Suppression lookups are exact on normalized values (emails lowercased; Gmail dots are not normalized: treat addresses literally; domains via the public suffix list; phones in E.164).
### Non-functional
- `evaluate` P95 < 20 ms with warm caches (policies cached per version; suppressions indexed and cached).
- Append-only tables protected by triggers (no UPDATE/DELETE except retention by a privileged role).

## Design
```
packages/contracts/src/compliance/{dsl.ts, decision.ts, policy.ts, suppression.ts, lawful-basis.ts}
apps/api/src/modules/compliance/
├── domain/{policy-evaluator.ts (pure), lattice.ts, overlays.ts, merge-stricter.ts, normalizers.ts,
│           explain.ts (EN/FR rendering), errors.ts}
├── application/{evaluate.ts, review-policy.ts, create-override.ts, suppress.ts, revoke-suppression.ts,
│                lawful-basis/*.ts, subscribers/on-site-opt-out.ts, queries/*}
├── infrastructure/{resolvers/{jurisdiction.resolver.ts, recipient-type/{fr-recherche-entreprises.adapter.ts,
│                   gb-companies-house.adapter.ts}, address-context.resolver.ts}, repositories/*,
│                   cache/suppression-cache.ts, seeds/policies/*.json}
└── interface/http/{compliance.controller.ts, suppressions.controller.ts, lawful-basis.controller.ts}
apps/web/src/features/compliance/{policies-matrix.tsx, rule-viewer.tsx, review-dialog.tsx, override-editor.tsx,
                                  lia-editor.tsx, compliance-panel.tsx}
tooling/architecture/{dependency-rules.cjs, compliance-gate.test.ts}
```
- Patterns:
  - Specification / Rules engine (DSL).
  - Lattice-based combination (most restrictive wins).
  - Strategy (resolvers per country).
  - Append-only log + projection (suppressions).
  - Policy versioning (immutable versions + head pointer).
  - Branded types as compile-time guards.
- Evaluation is a **pure function** `evaluatePolicy(policyVersions, inputs) → Decision`, which makes it exhaustively testable. All I/O (resolvers, suppression lookup) happens before it.

## Implementation plan
1. Contracts (DSL, decisions, suppression, LIA) and the pure evaluator with lattice, overlays and stricter merge (TDD; property tests).
2. Tables, triggers, seeds (policies from the compliance doc with sources, offer relevance, LIA template).
3. Resolvers (jurisdiction incl. BL/MF; recipient type FR adapter; address context) with caching.
4. `ComplianceService` (evaluate/persist/alternatives/auto-send permission), suppression core + cache, subscribers, events.
5. APIs + Settings UI (matrix, viewer, review, overrides, LIA) + compliance panel component + business section.
6. Architecture rules and tests; metrics and alerts; docs update (compliance doc "how the engine applies this").

## Testing
- **Unit** (pure evaluator; table-driven, ≥ 60 cases across jurisdictions, channels and inputs). Examples:
  - FR generic + relevant → `allowed_with_conditions` with elements;
  - NL generic not designated → `manual_only`;
  - BE personal → `blocked`;
  - DE email → `blocked`;
  - GB sole trader → `manual_only`;
  - unknown country → `manual_only`;
  - each overlay forces the expected result;
  - conflicting jurisdictions → the stricter.
- **Property:** stricter-only merge (no override input can produce a less restrictive decision); lattice monotonicity.
- **Integration:**
  - evaluate persists decisions with inputs and policy versions;
  - suppression add/revoke log and projection;
  - cache invalidation;
  - BL detection from a postcode/area fixture;
  - FR recipient-type adapter with recorded responses (MSW);
  - review gating for `isAutoSendPermitted`;
  - opt-out subscriber creates a suppression;
  - append-only triggers reject UPDATE.
- **Architecture:** the dependency rule test fails on a fixture violating the send-path rule.
- **UI/E2E:** owner reviews the FR policy and enables auto-send eligibility; a member cannot edit policies; the business compliance section explains a block in FR and EN.

## Acceptance criteria
- [x] Versioned typed-DSL policies seeded for US/FR/BL/MF/NL/BE/DE/GB/* across channels, all flagged for legal review, with sources.
- [x] Pure evaluator with overlays, most-restrictive combination and stricter-only overrides (property-tested).
- [x] `ComplianceService.evaluate` persisted decisions with explanations, required elements, alternatives; `isAutoSendPermitted` gating.
- [x] Append-only suppression core with fast lookup, events, opt-out subscriber; BF-028 pre-check port implemented.
- [x] Lawful-basis records with approval; offer relevance table.
- [x] Settings → Compliance UI (matrix, rule viewer, review, overrides, LIA) and reusable compliance panel.
- [x] Architecture rules preventing gate bypass; metrics and alerts.

## Agent prompt
```text
Implement BF-049 (Compliance policy engine).

Read first: AGENTS.md (§2 rule 7, §8), docs/adr/0012, docs/compliance/outreach-compliance.md (all), docs/DOMAIN.md
(Compliance decision, Suppression, Jurisdiction policy, Lawful basis; §2 invariants; §4 events), BF-011 (workspace
identity/readiness), BF-017 (areas incl. BL), BF-026 (no-solicitation), BF-028 (contact classification, suppression
pre-check port), BF-024 (do_not_contact), BF-048 (opt-out event). Skim BF-050…BF-057 (consumers).

Rules:
- Not legal advice: seed policies exactly from the compliance doc with sources and needs_legal_review=true; never
  invent legal rules — if unsure, choose the stricter outcome and document it.
- The evaluator is a pure function; most restrictive wins; overrides are stricter-only (property tests).
- Decisions are persisted with full inputs and policy versions, and explained in EN/FR.
- Make bypass impossible: branded decision ids, architecture rules, append-only tables.
- Verify the public company-registry API (recherche-entreprises) endpoint/terms before use; cache results.

Verify: pnpm verify && pnpm test:int && pnpm e2e (compliance settings); attach the decision table test summary.
```

## References
- ADR-0012 · docs/compliance/outreach-compliance.md · docs/DOMAIN.md
- CNIL (B2B email prospecting): https://www.cnil.fr/fr/les-regles-dor-de-la-prospection-par-courrier-electronique-0 · FTC CAN-SPAM guide: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business · ICO PECR: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/ · ACM spam rules (NL): https://www.acm.nl/nl/onderwerpen/telecommunicatie/internet/spam
- API Recherche d'entreprises: https://recherche-entreprises.api.gouv.fr/docs/ · Public Suffix List: https://publicsuffix.org/
