# ADR-0007: Better Auth with organizations for identity and multi-tenancy

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-010, BF-011

## Context

Two agency partners use the system today; more members and possibly more workspaces (other agencies) later. We need email/password with verification, OAuth (Google), 2FA, organizations with roles and invitations, API keys for automation, and sessions shared between `app.<domain>` (Next.js) and `api.<domain>` (NestJS). We want to own the user data in our Postgres.

## Decision

- **Better Auth** (latest stable) configured once in `@bf/auth` with the Drizzle adapter and plugins: `organization` (workspaces, roles, invitations, active organization on session), `twoFactor` (TOTP), `admin` (operator tooling), `apiKey` (automation keys) — verify plugin names/APIs against current docs.
- Mounted in **NestJS** at `/api/auth/*` (community integration `@thallesp/nestjs-better-auth` or an equivalent thin custom handler; the Nest body parser must be disabled for the auth route as documented). Global guard resolves the session into `RequestContext`; `@AllowAnonymous()` for public routes.
- Cookies: HttpOnly, Secure, SameSite=Lax, `crossSubDomainCookies` for the parent domain so `app.` and `api.` share the session.
- **Org context** comes from the session's active organization (or the API key's org), never from request bodies or paths.
- Roles: `owner`, `admin`, `member`, `viewer`; permissions matrix in `@bf/contracts/permissions.ts`, enforced by `@RequirePermission()` and mirrored in the UI.
- Transactional emails (verification, invites, password reset) go through the system mail transport (Mailpit locally, SMTP/Resend in prod), **not** the prospecting mailboxes.

## Alternatives considered

| Option | Why not |
|---|---|
| Auth.js (NextAuth) | Next.js-centric; organizations/roles/2FA require custom work; session sharing with a separate Nest API is awkward. |
| Clerk / WorkOS / Auth0 | Strong products; external dependency and per-MAU cost; user data outside our DB; less control over org model. |
| Custom auth | Security risk and time sink. |
| Keycloak / Zitadel | Powerful but heavy to operate for two users. |

## Consequences

- Positive: full ownership of identity data, organizations built-in, TypeScript-native.
- Negative: NestJS integration is community-maintained — wrapped behind our own `AuthModule` so it can be replaced by a ~50-line custom handler if needed.
- Negative: Better Auth evolves quickly; pin versions and run its schema generation when upgrading.

## References

- Better Auth: https://www.better-auth.com/docs
- NestJS integration (docs v1.6, community package): https://better-auth.com/docs/1.6/integrations/nestjs
