# SaaS readiness assessment

Status: assessment, written for BF-062. Not a commitment. All estimates are rough person-weeks for one engineer who knows the codebase, excluding legal counsel time.

## 1. Summary

Business Finder is a single-agency tool. Sign-up is invite-only, every workspace is operated by people we know, and the heaviest abuse surfaces (cold email, AI spend, crawled content) are kept honest by trust plus a few guardrails. The PRD keeps public self-serve SaaS out of v1 ([PRD §3 non-goals](../PRD.md)) and asks the architecture to keep the door open. It does: tenancy (`organization_id` on 37 schema columns), RBAC, API keys, per-workspace AI budgets, a compliance gate, mailbox caps and a sending kill switch all already exist and are org-scoped. The main blockers are not architectural. They are (1) outreach abuse: opening sign-up means strangers sending cold email through our infrastructure, which needs verified sending domains, per-tenant legal review and complaint monitoring before day one; (2) data isolation: there is no Postgres RLS today (BF-060 is deferred) and no cross-tenant test harness; (3) billing and a quotas service, neither of which exists; (4) legal paperwork (ToS, AUP, DPA, sub-processor list). Rough total: **22–34 person-weeks** of engineering over three phases, plus legal work we cannot estimate here. Until then the invite-only guarantee in §6 holds.

## 2. What public self-serve sign-up would require

### 2.1 Sign-up abuse controls

- **Why**: an open sign-up form is a free API key to search providers, LLMs and mail sending. Bots and throwaway accounts arrive within hours.
- **What exists today**: `SIGNUP_MODE` (`invite_only | allowlist | open`, `packages/config/src/fragments/auth.ts`) enforced in Better Auth's `user.create.before` hook for every method (`packages/auth/src/server.ts`, `signup.ts`, `signup-store.ts`); email verification on sign-up (`sendOnSignUp: true`); pwned-password check (`AUTH_CHECK_PWNED`); HTTP throttling per IP/user (`apps/api/src/modules/platform/security/throttler.guard.ts`, 60 req/min anonymous) and Better Auth's `rate_limits` table.
- **Gap**: no captcha, no disposable-domain blocking, no sign-up velocity limits per IP/ASN, no manual review queue, no "new tenant" probation state that caps spend and sends until a human looks.
- **Estimate**: 2–3 weeks (captcha + disposable list + velocity 1 week; review queue with tenant states `pending_review | active | suspended` and an operator UI 1–2 weeks).

### 2.2 Outreach abuse prevention

- **Why**: cold email is the product's riskiest surface. A single abusive tenant can get shared IPs, the platform's domains or a partner mailbox provider blacklisted, and can expose us to CAN-SPAM/RGPD/ePrivacy liability.
- **What exists today**: every send goes through `ComplianceService.evaluate()` (`apps/api/src/modules/compliance/application/compliance.service.ts`) with decisions and suppressions persisted (`compliance_decisions`, `suppressions_current`, `unsubscribe_tokens` in `packages/db/src/schema/compliance.ts`); tenants send only from their own connected mailboxes (BF-050: `mailboxes.daily_cap` default 50, ramp-up, `mailbox_daily_usage`, lifecycle `connected → warming → active → paused`); DNS authentication checks per sending domain and a readiness gate (BF-056: `deliverability_domains`, `mailbox_readiness_overrides`); a per-workspace **kill switch** (`deliverability_settings.kill_switch`, effective within seconds) and auto-pause rules on bounce/unsubscribe rates; jurisdiction policies per recipient (`compliance/domain/jurisdiction.ts`, `policy-evaluator.ts`).
- **Gap**: policies and overrides are workspace-configurable; a self-serve tenant must not be able to loosen them. Needs: stricter defaults for untrusted tenants (lower starting cap, longer warm-up, no readiness override); sending only from domains whose SPF/DKIM/DMARC pass with no override path; mandatory legal review (recorded `compliance_policy_reviews`) per jurisdiction before a tenant may send there; a **platform-level** kill switch per tenant (the current one is the tenant's own); complaint-rate and bounce monitoring aggregated per tenant with automatic suspension and operator alerts; a content review path for first campaigns.
- **Estimate**: 4–6 weeks.

### 2.3 Plan limits and a quotas service

- **Why**: without hard limits one tenant can consume the shared provider budgets (Google Places, LLMs, generation sandboxes) and storage.
- **What exists today**: per-workspace monthly AI budget with soft/hard states (`BudgetGuard` in `packages/ai/src/ports.ts`, `LedgerBudgetGuard` in `apps/api/src/modules/platform/ai/ai-adapters.ts`, fed by the `llm_calls` ledger); discovery and enrichment budgets reserved per run (`discovery.ts` `budget_usd/cost_usd/reserved_usd` with a check constraint; `org_settings.discovery/enrichment`); generation budgets per run (`generation.ts`); mailbox daily caps; API key rate limits (`apikey.rate_limit_*`).
- **Gap**: the limits are global env values (`AI_BUDGET_MONTHLY_SOFT_USD/HARD_USD`), not per plan; there is no single `QuotaService.consume(orgId, meter, amount)` with meters for searches, enrichments, AI spend, sends, sites and storage; no plan table; no usage summary endpoint; no storage accounting at all (assets, exports, screenshots).
- **Estimate**: 3–4 weeks (meter model + Valkey counters backed by Postgres 2 weeks; wiring six meters into existing use cases 1–2 weeks).

### 2.4 Billing integration point

- **Why**: self-serve means card on file, plan changes, metered overages and invoices that are valid in the EU (VAT, reverse charge, Saint-Barthélemy is outside the EU VAT area).
- **What exists today**: a `billing:manage` permission in the RBAC matrix (`packages/contracts/src/permissions.ts`), held only by owners and otherwise unused; `organizations` has no plan or billing columns; the audit log and outbox exist to record billing events.
- **Gap**: everything else. Suggested design: Stripe Customer per organization, Subscription per plan, metered usage reported from the quotas service, webhook handler (`checkout.session.completed`, `invoice.paid/payment_failed`, `customer.subscription.*`) as an idempotent inbound adapter under `modules/billing`, dunning that downgrades to a frozen state (read-only, no sends, no generation) rather than deleting data, Stripe Tax or equivalent for VAT. Pricing itself is a product decision, not covered here.
- **Estimate**: 3–4 weeks for a minimal integration, excluding pricing design and accounting setup.

### 2.5 Tenant-level sending domains and custom domains

- **Why**: tenants must send from their own domains (reputation is per domain, and we must never share one) and host live sites on their clients' domains.
- **What exists today**: sending is already per-tenant mailbox with per-domain checks (`deliverability_domains` keyed by `organization_id, domain`). Custom site domains (BF-062): `site_domains` with DNS verification tokens, hostname uniqueness across the platform, Caddy on-demand TLS gated by an `ask` endpoint that only answers for verified hostnames.
- **Gap**: unsubscribe links, tracking and preview URLs are served from the platform's domain; a tenant-branded link domain (CNAME, verified like `site_domains`) is needed so one tenant's reputation does not spill onto the shared domain. Per-tenant hostname quotas and an abuse path for phishing-looking hostnames.
- **Estimate**: 1–2 weeks.

### 2.6 Support tooling

- **Why**: operators must be able to see what a tenant sees, suspend tenants, and answer data requests without SQL.
- **What exists today**: `PLATFORM_OPERATOR_EMAILS` for cross-workspace operator tools (Bull Board, queue smoke test); `audit_logs` with actor type `user | api_key | system`, IP and user agent (`packages/db/src/schema/workspace.ts`); a DSR workflow with a state machine (`compliance/application/dsr.service.ts`, `dsr_requests`) and retention runs; secrets vault with key rotation runbook.
- **Gap**: no impersonation ("view as tenant") with a visible banner and audit trail; no tenant admin console (list tenants, status, usage, suspend/resume, notes); no self-serve full export or account deletion for a whole organization (the DSR flow is per data subject, not per tenant); no platform-wide notifications to tenants.
- **Estimate**: 3–4 weeks.

### 2.7 Legal

- **Why**: a public product needs enforceable terms, and B2B tenants in the EU will ask for a DPA before paying.
- **What exists today**: outreach compliance documentation (`docs/compliance/outreach-compliance.md`) and a data map (`docs/compliance/data-map.md`) that a privacy policy can be derived from; generated legal pages for the sites we host (BF-062 `site_legal_profiles`), which cover our clients' sites, not our own service.
- **Gap**: Terms of Service, Acceptable Use Policy (explicitly: no purchased lists, no sending outside policy-approved jurisdictions, no impersonation), a per-tenant DPA with our sub-processor list (search providers, LLM providers, mail providers, hosting, object storage), a privacy policy for the service, cookie notice for the dashboard, and acceptance tracking (version, timestamp, user) at sign-up and on changes.
- **Estimate**: 1 week of engineering (acceptance tracking, document hosting); legal drafting is external and not estimated.

### 2.8 Observability per tenant

- **Why**: cost control, fair-use enforcement and support all need per-tenant numbers.
- **What exists today**: `llm_calls` indexed by `(organization_id, created_at)`; discovery/enrichment/generation runs carry cost; `mailbox_daily_usage`; analytics daily rollups (BF-058); structured logs with correlation IDs and `orgId`; OpenTelemetry traces (`docs/OBSERVABILITY.md`).
- **Gap**: no tenant-level cost and usage dashboard (operator and tenant-facing), no per-tenant alerting (spend spikes, complaint rates), no storage metrics. Mostly aggregation over data that already exists.
- **Estimate**: 1–2 weeks.

### 2.9 Data isolation hardening

- **Why**: with strangers as tenants, a single missed `where organization_id = ?` becomes a data breach rather than an internal bug.
- **What exists today**: every org-scoped table has `organization_id` (37 columns across `packages/db/src/schema/*.ts`, e.g. `0063_go_live.sql`); repositories require `orgId`; the auth guard resolves `RequestContext {userId, orgId, role, permissions}` from the session or API key, never from the body; client portal routes check a per-site grant on every call and answer 404 otherwise (`apps/api/src/modules/sites/application/client-portal/portal.service.ts`, `site_portal_grants`); `apps/sites` uses a read-only DB role.
- **Gap**: grepping `packages/db/migrations` for `ROW LEVEL SECURITY` and `CREATE POLICY` returns nothing: **no RLS is in place**. BF-060 (RLS with `FORCE ROW LEVEL SECURITY`, `bf_app`/`bf_system` roles, a schema test for new tables, a generated cross-tenant test harness) is deferred. Object storage keys are prefixed by org but signed URLs are not covered by a cross-tenant test.
- **Estimate**: 3–4 weeks (this is BF-060's RLS and test-harness scope).

## 3. Architectural hooks already present

- Tenancy model: `organizations`, `members`, `invitation` (Better Auth organization plugin) in `packages/db/src/schema/auth.ts`; `organization_id` on every domain table, with `onDelete: 'cascade'` so tenant deletion is a single delete.
- RBAC: four roles and twenty permissions in `packages/contracts/src/permissions.ts`, including an unused `billing:manage`; `@RequirePermission` guards and `PolicyService` (`docs/ARCHITECTURE.md`, AuthZ row); Better Auth role statements derived from the same matrix in `packages/auth/src/roles.ts`.
- Sign-up policy: `SIGNUP_MODE` in `packages/config/src/fragments/auth.ts`, decided by `isSignupAllowed()` in `packages/auth/src/signup.ts` and enforced in the `user.create.before` hook in `packages/auth/src/server.ts`; invitations and portal grants are the only exceptions in `invite_only` mode.
- API keys: Better Auth api-key plugin (`apikey` table) with per-key permissions as a subset of the creator's, expiry and rate limits; `Authorization: Bearer bf_…` resolves to the same `RequestContext` as a session.
- AI budgets: `BudgetGuard` port (`packages/ai/src/ports.ts`) with a `LedgerBudgetGuard` over the `llm_calls` ledger, soft/hard states and a once-per-month soft-limit event; the same shape fits a per-plan quota.
- Run-level budgets: discovery (`discovery.ts`, reserve-then-settle with a check constraint), enrichment and generation runs each carry `budget_usd`.
- Compliance gate: `ComplianceService.evaluate()` is the only path to a send; decisions, suppressions, lawful-basis records and policy reviews are persisted per organization (`packages/db/src/schema/compliance.ts`).
- Sending controls: mailbox caps, ramp-up and lifecycle (`mailboxes.ts`); DNS authentication checks, readiness overrides and a per-workspace kill switch (`deliverability.ts`).
- Client portal grants: `site_portal_grants` give a non-member access to one site via magic link; a template for scoped external access (`apps/api/src/modules/sites/application/client-portal/`).
- Custom domains with verification and on-demand TLS gated by an `ask` endpoint (`packages/db/src/schema/go-live.ts`, BF-062), reusable for tenant link domains.
- Operations: `audit_logs` (actor, action, IP, user agent), outbox events, DSR state machine and retention runs, encrypted secrets vault with versioned master keys, `PLATFORM_OPERATOR_EMAILS` for cross-workspace tools.
- Config discipline: all env in `@bf/config` Zod fragments, so per-plan limits can replace global values without touching call sites.

## 4. Current gaps

| Area | Gap | Severity | Estimate |
|---|---|---|---|
| Data isolation | No Postgres RLS, no cross-tenant test harness (BF-060 deferred) | Critical | 3–4 w |
| Outreach abuse | Tenants can loosen sending policy; no platform kill switch per tenant; no complaint monitoring per tenant; no legal review gate per tenant/jurisdiction | Critical | 4–6 w |
| Sign-up abuse | No captcha, disposable-domain block, velocity limits or review queue | High | 2–3 w |
| Quotas | Limits are global env values; no meters for searches, enrichments, sends, sites, storage | High | 3–4 w |
| Billing | Nothing beyond a permission string | High | 3–4 w |
| Support tooling | No impersonation, tenant console, org-level export/delete | Medium | 3–4 w |
| Legal | No ToS, AUP, DPA, sub-processor list, acceptance tracking | High (blocking launch, low engineering) | 1 w + counsel |
| Sending/link domains | Shared platform domain for unsubscribe/tracking links | Medium | 1–2 w |
| Observability | No per-tenant cost/usage dashboards or alerts | Medium | 1–2 w |
| Tenant lifecycle | No `pending_review / active / suspended / frozen` state on organizations | High | included in 2.1 and 2.4 |

## 5. Suggested phased plan

**Phase 1 — Safe to let strangers in (8–12 weeks).** RLS and the cross-tenant harness (BF-060 scope); tenant lifecycle states and a platform-level kill switch per tenant; locked-down sending defaults for untrusted tenants with no override path; sign-up abuse controls and a manual review queue; ToS/AUP/privacy acceptance tracking. Sign-up stays `invite_only`; this phase is about the blast radius of a bad tenant.

**Phase 2 — Metered and billable (7–10 weeks).** Quotas service with six meters; plan table; Stripe customers, subscriptions, metered usage, webhooks and dunning to the frozen state; per-tenant usage dashboards and alerts; tenant-branded link domains. Allowlisted design partners onboard here with `SIGNUP_MODE=allowlist`.

**Phase 3 — Operable at scale (7–12 weeks).** Tenant admin console with audited impersonation; org-level export and deletion; complaint-rate monitoring with automatic suspension; per-jurisdiction legal review workflow for tenants; DPA and sub-processor list published. Then `FEATURE_SELF_SERVE_SIGNUP=true` with `SIGNUP_MODE=open`.

**Total: roughly 22–34 person-weeks of engineering**, sequential for one engineer, plus legal counsel and the pricing decision. The range is wide because Phase 1 depends on how much of BF-060 ships independently and Phase 3 on how much support tooling we accept to do by hand at first.

## 6. The invite-only guarantee today

- Sign-up is closed unless `SIGNUP_MODE` is changed. The default is `invite_only` in production (`signupModeOf()`; the variable is declared in `packages/config/src/fragments/auth.ts`); the decision lives in `isSignupAllowed()` (`packages/auth/src/signup.ts`) and is enforced in Better Auth's `user.create.before` hook for every sign-up method, so Google OAuth cannot bypass it. Rejections are 403 `signup_closed`.
- BF-062 adds the feature flag `FEATURE_SELF_SERVE_SIGNUP` (default `false`). In production, public sign-up needs **both** `FEATURE_SELF_SERVE_SIGNUP=true` **and** `SIGNUP_MODE=open`: with `SIGNUP_MODE=open` alone the API refuses to start (`signupModeOf()` in `apps/api/src/modules/identity/infrastructure/better-auth.provider.ts`), and the flag alone changes nothing. Outside production `SIGNUP_MODE` still defaults to `open` for development and E2E. A unit test for this is part of the deferred test debt.
- The only ways in are a pending, unexpired invitation to a workspace (`invitation` table, checked in `packages/auth/src/signup-store.ts`) and a client-portal grant for a specific site (`site_portal_grants`, checked by `hasPortalGrant()`), which creates a client account with no workspace membership.
- `allowlist` mode (`SIGNUP_ALLOWED_EMAIL_DOMAINS`) remains available for design partners and is not public sign-up.

Any change to this section is a product decision that must go through Phase 1 above first.
