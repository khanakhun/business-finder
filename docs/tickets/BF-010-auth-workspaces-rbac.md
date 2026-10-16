---
id: BF-010
title: Authentication, workspaces and role-based access control
milestone: M1 Find & List
epic: identity
type: feature
priority: P0
size: L
depends_on: [BF-006, BF-007]
blocks: [BF-011, BF-012, BF-023, BF-025, BF-050, BF-060]
areas: [api, web, security]
---

# BF-010 — Authentication, workspaces and role-based access control

## Context
Identity uses Better Auth with organizations ([ADR-0007](../adr/0007-better-auth-with-organizations.md)). Roles and permissions are defined once in `@bf/contracts/permissions.ts` (BF-004, [DOMAIN.md §5](../DOMAIN.md#5-permissions-excerpt)). BF-006 left a production boot guard and basic-auth on Bull Board, both replaced here. This is an internal tool: open sign-up must be off in production.

## Goal
Users can sign up (when allowed), verify email, sign in (password or Google), enable TOTP 2FA, belong to one or more workspaces with roles, invite members, switch workspace; every API route enforces permissions and org scoping; the dashboard is protected and permission-aware.

## Scope
**In scope**
- `packages/auth` (`@bf/auth`): `createAuth({ db, env, mailer })` Better Auth configuration — Drizzle adapter; email+password (min length 12, breached-password check if the plugin exists, email verification required); Google OAuth (enabled only if `GOOGLE_CLIENT_ID/SECRET` set); plugins: organization (roles `owner|admin|member|viewer`, invitations, active organization on session), two-factor (TOTP + backup codes), API keys (Better Auth plugin if it supports org scoping/metadata; otherwise a custom `api_keys` table: hashed key, prefix `bf_`, org, created_by, permissions subset, last_used_at, expires_at, revoked_at); session settings (7-day sliding, cookie cache short), `crossSubDomainCookies` for the parent domain, `trustedOrigins` = app URL; rate limits for auth endpoints. Typed client export for the web app.
- Auth tables generated with the Better Auth CLI into `packages/db/src/schema/auth.ts` and migrated through our Drizzle pipeline (one migration).
- Sign-up policy: `SIGNUP_MODE = invite_only | allowlist | open` (default `invite_only` in production, `open` in development); allowlist via `SIGNUP_ALLOWED_EMAIL_DOMAINS`. CLI `pnpm admin:bootstrap --email <e> --name <n> --workspace <w>` creates the first owner + workspace (prints a one-time sign-in link; works only when no users exist unless `--force`).
- NestJS `identity` module:
  - Mounts the Better Auth handler at `/api/auth/*` (via `@thallesp/nestjs-better-auth` or a thin custom controller — verify current integration; disable Nest body parsing for that route as documented).
  - Global `AuthGuard`: resolves session cookie **or** `Authorization: Bearer bf_…` API key → `RequestContext { userId, orgId, role, permissions, authMethod }` (ALS + log context). Requests without org context (no active organization) get `orgId = null` and can only hit routes marked `@NoOrgRequired()`.
  - Decorators: `@AllowAnonymous()`, `@RequirePermission(...perms)`, `@NoOrgRequired()`, param decorators `@Ctx()`.
  - `PolicyService.assert(ctx, permission)` for use inside use cases (defense in depth).
  - `GET /v1/me` → `{ user, activeOrganization, role, permissions[], organizations[] }`.
  - Members API (`members:manage`): list, invite (email + role), resend/revoke invite, change role (cannot demote last owner), remove member, transfer ownership (owner only).
  - API keys API (`settings:manage`): create (returns key once), list (prefix + metadata), revoke.
  - System emails via `SystemMailer` port (SMTP adapter with nodemailer → Mailpit locally; templates with React Email: verify email, invitation, password reset, 2FA enabled notice) — EN/FR by user locale.
  - Replace BF-006's production boot guard and Bull Board basic auth (Bull Board now requires `settings:manage`).
  - Domain events: `identity.user_signed_up`, `identity.member_invited`, `identity.member_role_changed`, `identity.member_removed`, `identity.api_key_created/revoked` (recorded through the outbox once BF-012 lands; until then logged — leave a `TODO(BF-012)` hook point).
- Web (`apps/web`):
  - Pages: `/sign-in`, `/sign-up` (hidden unless allowed), `/verify-email`, `/forgot-password`, `/reset-password`, `/invite/[token]`, `/two-factor` (challenge).
  - Protected dashboard layout: server-side session check via `GET /v1/me` (cookies forwarded); redirect to `/sign-in?next=…`.
  - Workspace switcher in the top bar (list orgs, switch active org, create workspace if role/policy allows).
  - `/settings/account` (profile name/locale, password change, 2FA enable/disable with QR + backup codes, active sessions with revoke).
  - `/settings/members` (table, invite dialog, role select, remove, pending invites).
  - `/settings/api-keys`.
  - Permission-aware UI: `usePermission('outreach:send')` hides/disables actions; server still enforces.

**Out of scope**
- Workspace settings, secrets vault, audit log UI (→ BF-011). Outbox-backed events (→ BF-012). SSO/SAML.

## Requirements
### Functional
- All `/v1` routes require auth by default; anonymous routes must be explicitly marked and are listed in `apps/api/README.md`.
- A user in workspace A cannot read or mutate anything in workspace B (404 on cross-org access).
- The last owner cannot leave/demote themselves.
### Non-functional
- Password hashing per Better Auth defaults (scrypt/argon2 — verify); auth endpoints rate limited (e.g. 10/min/IP for sign-in).
- Cookies: HttpOnly, Secure (prod), SameSite=Lax; CSRF protections per Better Auth + Origin check on state-changing API requests.

## Design
```
packages/auth/src/{server.ts, client.ts, roles.ts, emails.ts}
packages/db/src/schema/auth.ts                # generated by Better Auth CLI, committed
apps/api/src/modules/identity/
├── domain/{membership-policy.ts}              # last-owner rule, role change rules
├── application/{commands/*, queries/get-me.query.ts, ports/system-mailer.port.ts}
├── infrastructure/{better-auth.provider.ts, api-key.repository.ts, smtp-system-mailer.ts, emails/*}
├── interface/http/{auth.controller.ts?, me.controller.ts, members.controller.ts, api-keys.controller.ts}
└── guards/{auth.guard.ts, permission.guard.ts}
apps/web/src/app/(auth)/{sign-in,sign-up,verify-email,forgot-password,reset-password,invite/[token],two-factor}/page.tsx
apps/web/src/app/(dashboard)/settings/{account,members,api-keys}/page.tsx
```
- Role ↔ permission mapping comes only from `@bf/contracts/permissions.ts`; Better Auth's organization roles store the role name; our guard computes permissions.

## Implementation plan
1. Verify Better Auth current version, plugin names/APIs (organization, twoFactor, apiKey), Drizzle adapter, CLI schema generation, NestJS integration, and React client APIs.
2. `@bf/auth` config + schema generation + migration.
3. Identity module: guard, decorators, policy service, `/v1/me`, members & API keys use cases with domain rules (unit tests first).
4. System mailer + templates (EN/FR) + fake mailer for tests.
5. Bootstrap CLI and sign-up policy.
6. Web pages, protected layout, switcher, settings pages, permission hooks.
7. Remove BF-006 guards; protect Bull Board.

## Testing
- Unit: membership policy (last owner, allowed role changes by role), permission matrix usage, API key hashing/verification.
- Integration (HTTP, Testcontainers): sign-up → verification email captured by fake mailer → verify → sign-in → `/v1/me`; invite → accept → role applied; viewer forbidden on a `business:write` sample route (403); cross-org resource → 404; API key auth works and respects revoke/expiry; 2FA enable → sign-in requires TOTP (use `otplib` in tests); rate limit on sign-in.
- E2E: sign-in flow, workspace switch, invite member (Mailpit link), 2FA setup page renders QR.

## Acceptance criteria
- [x] Email/password with verification, Google OAuth (when configured) and TOTP 2FA work end-to-end.
- [x] Workspaces with roles and invitations; last-owner protection; ownership transfer.
- [x] Every `/v1` route enforces auth + permission; anonymous routes explicit; tests cover 401/403/404 cases.
- [x] API keys (create once, hashed, revocable, scoped to org) authenticate API calls.
- [x] Dashboard protected; permission-aware UI; settings pages for account, members, API keys (EN/FR).
- [x] `pnpm admin:bootstrap` creates the first owner; sign-up mode enforced by config.
- [x] BF-006 production guard removed; Bull Board requires `settings:manage`.

## Agent prompt
```text
Implement BF-010 (Authentication, workspaces and RBAC).

Read first: AGENTS.md, docs/adr/0007-better-auth-with-organizations.md, docs/DOMAIN.md §5, docs/conventions/security.md
§1–§2, docs/conventions/api.md §2. Reuse BF-006 (platform module, guards hook points), BF-007 (shell, @bf/ui,
api client), @bf/contracts permissions (BF-004).

Rules:
- Better Auth changes quickly: read the current docs for the organization, two-factor and API key plugins,
  the Drizzle adapter + CLI schema generation, and the NestJS integration before coding. Record versions.
- Our permission matrix in @bf/contracts is the only source of truth for what a role can do.
- Org context comes from the session/API key only. Write the cross-org 404 tests before the controllers.
- Security review is mandatory for this ticket: run the security-reviewer subagent and address findings.

Split suggestion: part 1 backend (auth config, guard, /v1/me, members, API keys, bootstrap CLI);
part 2 web (auth pages, protected layout, switcher, settings pages).

Verify: pnpm verify && pnpm test:int && pnpm e2e. Demonstrate in the PR: sign-up → verify (Mailpit) → sign-in →
invite → accept; viewer blocked from a write route; API key request succeeds.
```

## References
- ADR-0007 · docs/DOMAIN.md §5 · docs/conventions/security.md · docs/conventions/api.md §2
- Better Auth docs: https://www.better-auth.com/docs · NestJS integration: https://better-auth.com/docs/1.6/integrations/nestjs · React Email: https://react.email/

## Implementation notes
- **Versions** (checked against the installed type definitions): better-auth 1.7.8, @better-auth/api-key 1.7.8,
  Better Auth CLI 1.7.8 (schema generation), nodemailer 10.1.1, @react-email/components 1.0.12 /
  @react-email/render 2.1.0, otplib 13.5.0 (tests), uqr 0.1.3 (QR code as SVG, no canvas), server-only 0.0.1.
- **Split**: part 1/3 `@bf/auth` + schema + migration + sign-up policy; part 2/3 identity module (guard,
  `/v1/me`, members, invitations, API keys, mailer, bootstrap CLI); security-review fixes; part 3/3 web pages,
  protected layout, switcher, settings, E2E.
- **Better Auth in Nest**: a thin Express middleware (`identity/infrastructure/better-auth-http.ts`) mounted before
  the body parsers, not `@thallesp/nestjs-better-auth`: only an allowlist of Better Auth endpoints is exposed (the
  members/API-key endpoints go through our use cases so the permission matrix and domain rules apply).
- **Guard**: one middleware resolves session cookie or `Bearer bf_…` key into an `AuthContext`; a global
  `AuthorizationGuard` enforces `@AllowAnonymous()` / `@RequirePermission()` / `@NoOrgRequired()` /
  `@OperatorOnly()`; a route without a policy is refused. `routes.test.ts` pins the anonymous, operator and
  org-less route lists. Defense in depth lives in the use cases (`memberActor()` + `membership-policy.ts`) rather
  than a separate `PolicyService`.
- **Sessions**: 7-day sliding (refreshed at most daily), cookie cache **off** so revocation is immediate;
  `bf.`-prefixed HttpOnly SameSite=Lax cookies, Secure in production; a new session starts in the user's first
  workspace (`session-defaults.ts`). Origin check on unsafe `/v1` requests made with a session.
- **Rate limits**: Better Auth's limiter with database storage (shared across instances): 100/min/IP default,
  sign-in 10, sign-up 5, password reset 5, 2FA 10; plus a per-account sign-in throttle in Valkey. The client IP is
  the first untrusted hop walking back from the socket peer through `AUTH_TRUSTED_PROXIES` (client-prepended
  X-Forwarded-For entries are ignored; header-less requests get their own bucket). The E2E API trusts loopback and
  each test sends its own client IP.
- **API keys**: Better Auth's API key plugin, organization-owned (`references: organization`), prefix `bf_`,
  permissions a subset of the creator's; keys survive their creator leaving (they belong to the workspace).
  The plugin hashes with SHA-256 without a pepper (the ticket allowed the plugin) — high-entropy keys make a pepper
  of little value; noted in QUESTIONS.md.
- **Bull Board / ping job**: operator-only (`PLATFORM_OPERATOR_EMAILS`, verified session) instead of
  `settings:manage`: both span every workspace, and a workspace owner must not see other workspaces' jobs.
- **Sign-up policy**: `SIGNUP_MODE` (default `invite_only` in production, `open` otherwise), allowlist by email
  domain, enforced for every method (email and Google) and for workspace creation; invitations always allowed.
  Refused sign-ups get the same response as accepted ones (no account enumeration).
- **Web**: auth pages in `(auth)`, protected `(dashboard)` layout (server-side `GET /v1/me`, `?next=` validated by
  `safe-next.ts`: parsed as a URL, same origin only, control characters rejected), workspace switcher + account menu in the top bar, `/settings/{account,members,api-keys}`,
  `usePermission()`; the web app imports only `@bf/auth/client` (boundary rule).
- **Problem `reason`**: `ProblemDetails` gained an optional UPPER_SNAKE_CASE `reason` (from a domain error's
  `details.reason`, 4xx only) so the dashboard can localize domain refusals such as `LAST_OWNER`.
- **OpenAPI**: shared `$defs` from `@bf/contracts` are promoted to components (fix in the schema registry); anonymous
  routes still list the global security requirement (Swagger drops an empty override) — cosmetic.
- **Tests**: API 115 unit / 57 integration, `@bf/auth` 10 integration, web 54 unit, E2E 27 (sign-in redirect, wrong
  password, axe on auth pages, workspace switch, invite via Mailpit link, 2FA QR, members axe), green three
  consecutive runs.

