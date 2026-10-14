---
id: BF-060
title: Security hardening — threat model, Postgres RLS defense in depth, sandbox and secrets hardening, ASVS review
milestone: M5 Learn & Scale
epic: ops
type: chore
priority: P0
size: L
depends_on: [BF-010, BF-011, BF-036, BF-043, BF-048, BF-052, BF-054]
blocks: [BF-061]
areas: [security, api, db, infra]
---

# BF-060 — Security hardening: threat model, Postgres RLS defense in depth, sandbox and secrets hardening, ASVS review

## Context
By M5 the platform has:
- many trust boundaries: public renderer and forms, public unsubscribe, OAuth mailbox tokens, coding agents executing tools in sandboxes, crawled and emailed untrusted content reaching LLMs;
- multi-tenant data;
- outbound email on the agency's reputation.

Each ticket followed [security.md](../conventions/security.md). This ticket steps back:
1. writes a **threat model** of the whole system;
2. adds **defense in depth**, chiefly Postgres row-level security (RLS) for org-scoped tables, so a buggy repository cannot leak another workspace's data;
3. closes hardening follow-ups recorded in earlier tickets (sandbox broker, per-run networks, key rotation);
4. verifies the platform against OWASP ASVS Level 2 and the OWASP LLM Top 10.

## Goal
A maintained STRIDE threat model with mitigations mapped to code and tests. In addition:
- RLS enabled and enforced for every org-scoped table, with a cross-tenant test harness;
- secrets key rotation;
- sandbox hardening (broker or socket-proxy tightening, per-run networks, optional gVisor);
- auth hardening (2FA enforcement, step-up re-auth);
- headers, CSP and rate-limit verification suites;
- an ASVS L2 / LLM Top 10 checklist with evidence;
- incident response and breach-notification runbooks.

## Scope
**In scope**
- **Threat model** `docs/security/threat-model.md`:
  - System decomposition with data-flow diagrams (mermaid), trust boundaries and assets: workspace data, prospect PII, mailbox tokens, model API keys, sending reputation, sites domain reputation.
  - STRIDE per element: web, api, worker, sites renderer, intel, agent runner, egress proxy, Postgres, Valkey, object storage, Caddy, CI/CD.
  - **LLM-specific threats** (OWASP LLM Top 10 mapping): prompt injection via crawled pages, emails and reviews; insecure output handling (specs, HTML, emails); excessive agency (tools); data leakage across workspaces via caches; model DoS / cost exhaustion.
  - For each threat: likelihood, impact, existing mitigations (links to code/tests), gaps → issues created as follow-up tickets where out of scope.
  - Review cadence: per milestone and on architectural change; changes go through an ADR.
- **Postgres RLS (defense in depth)**:
  - Enable RLS + `FORCE ROW LEVEL SECURITY` on every table with `organization_id`. Policy: `organization_id = current_setting('app.org_id')::uuid` (USING + WITH CHECK).
  - Global tables (business graph) stay readable. Write paths for global tables use a dedicated role.
  - Application roles:
    - `bf_app` (no `BYPASSRLS`), used by request and job handlers;
    - `bf_system` (`BYPASSRLS`), used only by explicitly marked system jobs (retention, outbox relay, analytics ingestion) through a separate connection pool with an audit log of usage;
    - `bf_sites_ro` (existing, view-only).
  - `TransactionContext` (AsyncLocalStorage from BF-003/BF-006) issues `SET LOCAL app.org_id = …` at transaction start. Queries outside a transaction on org-scoped tables are forbidden (lint rule + runtime guard in the Drizzle client wrapper).
  - Migration adds policies for all existing tables. A **schema test** fails when a new table with `organization_id` lacks RLS and policies, which keeps future tickets compliant.
  - **Cross-tenant test harness**: for every repository method and API route, a generated test runs as org A against data of org B and asserts no access (404/empty). It covers SSE realtime channels and file and artifact signed URLs.
- **Secrets and keys**:
  - Envelope encryption master key rotation: support multiple key versions (`kid`), a re-encryption background job, a rotation runbook, and a test proving old secrets remain decryptable until re-encrypted.
  - API keys: hash + pepper rotation procedure.
  - OAuth token encryption verified; secrets scanning (gitleaks) on the history and pre-commit.
- **Sandbox hardening** (follow-ups from BF-043):
  - Replace or tighten the Docker socket proxy with a **sandbox broker** service: a tiny service owning the socket and exposing only `createRun(spec)` with server-side fixed image digests and limits. The worker gets broker credentials, not Docker API access.
  - Per-run internal networks (only the proxy attached), or document why the shared internal network is acceptable.
  - Evaluate the **gVisor** (`runsc`) runtime for runner containers: compatibility with Chromium and the CLIs, and performance. Adopt it if viable; record the decision as an ADR.
  - Egress proxy audit: deny logging reviewed; DNS exfiltration path considered (proxy-only DNS, no resolver in the sandbox).
- **AuthN/AuthZ hardening**:
  - 2FA required for owners and admins (enforced at sign-in after a grace period).
  - Step-up re-authentication (recent auth ≤ 10 min) for sensitive actions: secrets changes, mailbox connect/disconnect, compliance policy review/override, suppression revoke, DSR execution, member role changes, kill switch resume, model promotion.
  - Session and device list with revoke.
  - Brute-force protections verified (rate limits + lockout with exponential backoff).
  - Permission matrix tests generated from `@bf/contracts/permissions.ts` for every route.
- **Web security verification suites**:
  - Headers tests (CSP with nonces on web and sites; `frame-ancestors`, HSTS, COOP/CORP where applicable).
  - CORS tests for public endpoints.
  - Cookie flags; CSRF strategy verification for state-changing routes (SameSite + origin check).
  - Upload validation (magic bytes, size).
  - SSRF suite against `SafeHttpClient`: IPv6 and IPv4-mapped addresses, DNS rebinding, redirect chains.
  - HTML sanitization tests (inbox, rich text).
  - Open-redirect scan.
- **Rate limiting and abuse**: inventory of public and expensive endpoints with limits (auth, public leads, unsubscribe, views, search intent, AI endpoints, generation creation), with tests; per-org AI budget enforcement verified (BF-013).
- **Supply chain**:
  - Dependency review gates (OSV/pnpm audit with severity thresholds).
  - SBOMs for all images (syft) attached to releases; image signing with cosign (keyless via GitHub OIDC) and verification at deploy (BF-061 hook).
  - Renovate configuration (grouped updates, pinned digests).
  - CodeQL or Semgrep rulesets including custom rules: no raw `process.env`, no `dangerouslySetInnerHTML` outside the sanitizer component, no direct mailbox send imports.
- **ASVS L2 / LLM Top 10 review**: `docs/security/asvs-l2-checklist.md` with each requirement marked pass/fail/n.a. with evidence links. Failing items fixed in this ticket if small, otherwise follow-up tickets.
- **Runbooks**:
  - `docs/runbooks/incident-response.md`: severity levels, roles, communication, evidence preservation, post-mortem template.
  - `docs/runbooks/data-breach.md`: GDPR Art. 33/34: 72-hour authority notification assessment, subject notification criteria, records.
  - `docs/runbooks/key-compromise.md`: model keys, OAuth tokens, master key, sending domain.
- **External pen test readiness**: scope document and test accounts procedure (the pen test itself is outside engineering scope).

**Out of scope**
- SOC 2 / ISO certification work, WAF/CDN vendor adoption (documented option), bug bounty.

## Requirements
### Functional
- With RLS enabled, all existing tests pass. The cross-tenant harness proves isolation for every route and repository method.
- Sensitive actions require recent authentication and 2FA for privileged roles.
### Non-functional
- RLS overhead < 5% on the main listing query (benchmark before/after).
- Security suites run in CI; any new org-scoped table without RLS fails CI.

## Design
```
docs/security/{threat-model.md, asvs-l2-checklist.md, llm-top10.md}
docs/runbooks/{incident-response.md, data-breach.md, key-compromise.md}
packages/db/src/{rls/policies.sql.ts, rls/schema-guard.test.ts, client/org-scoped-client.ts}
apps/api/src/common/security/{step-up.guard.ts, rate-limits.ts}
apps/api/test/security/{cross-tenant/*.test.ts (generated), headers.test.ts, ssrf.test.ts, csrf.test.ts}
services/sandbox-broker/ (if adopted)
tooling/semgrep/*.yml
```
- Patterns:
  - Defense in depth (application scoping + RLS).
  - Policy-as-code (RLS migrations + guard tests).
  - Least privilege (DB roles, broker).
  - Generated security tests from registries (routes, permissions, tables).

## Implementation plan
1. Threat model workshop document (DFDs, STRIDE, LLM Top 10); create follow-up issues for gaps.
2. RLS: roles, policies migration, `SET LOCAL` in `TransactionContext`, guard tests, system-role pool; benchmark.
3. Cross-tenant harness generated from route and repository registries.
4. Auth hardening (2FA enforcement, step-up guard, sessions UI).
5. Secrets rotation (multi-key envelope, re-encryption job) + runbooks.
6. Sandbox broker / per-run networks / gVisor evaluation + ADR.
7. Web security suites, rate-limit inventory, supply-chain gates, Semgrep custom rules.
8. ASVS checklist with evidence; incident and breach runbooks.

## Testing
- RLS schema guard; cross-tenant harness (all routes and repositories); RLS bypass attempts (missing `SET LOCAL` raises an error, not a silent full scan).
- Step-up and 2FA enforcement E2E; key rotation integration test.
- Security suites (headers, CORS, CSRF, SSRF, sanitization, open redirect) in CI.
- Sandbox: broker refuses non-allowlisted images and limits; the security suite from BF-043 re-run under gVisor if adopted.

## Acceptance criteria
- [ ] Threat model (STRIDE + LLM Top 10) with mitigations mapped to code/tests and follow-ups filed.
- [ ] RLS on all org-scoped tables with roles, `SET LOCAL` context, schema guard and cross-tenant harness; benchmark within budget.
- [ ] 2FA enforcement for privileged roles and step-up re-auth for sensitive actions.
- [ ] Master key rotation with re-encryption job and runbooks.
- [ ] Sandbox hardening decisions implemented (broker / networks / gVisor evaluated) with an ADR.
- [ ] Security suites, rate-limit inventory, supply-chain gates and custom static rules in CI; ASVS L2 checklist with evidence.

## Agent prompt
```text
Implement BF-060 (Security hardening and threat model).

Read first: AGENTS.md (§8), docs/conventions/security.md (all), docs/ARCHITECTURE.md §13, docs/adr/0004, 0007, 0010,
0012, 0014, and the tickets whose surfaces you harden: BF-010/BF-011 (auth, secrets), BF-036/BF-048 (public renderer,
forms), BF-043 (sandbox), BF-050/BF-052/BF-054/BF-055 (mailboxes, sending, inbound, public unsubscribe).

Rules:
- Evidence over assertions: every mitigation links to code and a test.
- RLS is defense in depth, not a replacement for repository scoping; both stay.
- Make regressions impossible: schema guard for RLS, generated cross-tenant and permission tests, CI gates.
- Record architectural security decisions as ADRs (sandbox broker, gVisor).

Verify: pnpm verify && pnpm test:int && pnpm e2e && security suites; attach the RLS benchmark and the ASVS checklist summary.
```

## References
- docs/conventions/security.md · docs/ARCHITECTURE.md §13
- OWASP ASVS: https://owasp.org/www-project-application-security-verification-standard/ · OWASP Top 10 for LLM Applications: https://genai.owasp.org/llm-top-10/ · PostgreSQL row security policies: https://www.postgresql.org/docs/current/ddl-rowsecurity.html · gVisor: https://gvisor.dev/docs/ · Sigstore cosign: https://docs.sigstore.dev/ · Microsoft STRIDE threat modeling: https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats
