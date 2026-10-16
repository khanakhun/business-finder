import { API_KEY_PREFIX, fromStatements } from '@bf/auth';
import type { ApiEnv } from '@bf/config';
import { ROLE_PERMISSIONS } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import type { AuthContext, AuthResolution, AuthResolver } from '../../platform/security/auth-context.ts';
import { MEMBERSHIP_REPOSITORY, type MembershipRepository } from '../application/ports.ts';
import { type Auth, BETTER_AUTH } from './better-auth.provider.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Session cookie or `Authorization: Bearer bf_…` → AuthContext. Org context comes from the session's active
 * organization (re-checked against current membership) or from the key's owning organization.
 */
@Injectable()
export class BetterAuthResolver implements AuthResolver {
  private readonly appOrigin: string;
  private readonly operators: ReadonlySet<string>;

  constructor(
    @Inject(BETTER_AUTH) private readonly auth: Auth,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository,
    @Inject(APP_ENV) env: AppEnv,
  ) {
    this.appOrigin = new URL((env as ApiEnv).APP_URL).origin;
    this.operators = new Set((env as ApiEnv).PLATFORM_OPERATOR_EMAILS);
  }

  async resolve(req: Request): Promise<AuthResolution> {
    const authorization = req.headers.authorization;
    if (authorization) {
      const token = BEARER.exec(authorization)?.[1];
      if (!token?.startsWith(API_KEY_PREFIX))
        return { kind: 'invalid', reason: 'unsupported authorization header' };
      return this.fromApiKey(token);
    }
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return { kind: 'anonymous' };
    const activeOrg = session.session.activeOrganizationId ?? null;
    // A removed member keeps the org id on their session until it changes: membership is checked every time.
    const role = activeOrg ? await this.members.roleOf(session.user.id, activeOrg) : undefined;
    const auth: AuthContext = {
      method: 'session',
      userId: session.user.id,
      apiKeyId: null,
      orgId: role ? activeOrg : null,
      role: role ?? null,
      permissions: role ? ROLE_PERMISSIONS[role] : new Set(),
      crossOrigin: !SAFE_METHODS.has(req.method) && !this.fromApp(req),
      operator: session.user.emailVerified && this.operators.has(session.user.email.toLowerCase()),
    };
    return { kind: 'authenticated', auth };
  }

  private async fromApiKey(key: string): Promise<AuthResolution> {
    const result = await this.auth.api.verifyApiKey({ body: { key } });
    if (!result.valid || !result.key)
      return { kind: 'invalid', reason: 'invalid, expired or revoked API key' };
    const auth: AuthContext = {
      method: 'api_key',
      userId: null,
      apiKeyId: result.key.id,
      orgId: result.key.referenceId,
      role: null,
      permissions: new Set(fromStatements(result.key.permissions)),
      crossOrigin: false,
      operator: false,
    };
    return { kind: 'authenticated', auth };
  }

  /** Origin, else Referer, must be the dashboard (security.md §1). A write with neither is refused. */
  private fromApp(req: Request): boolean {
    const origin = req.headers.origin ?? req.headers.referer;
    if (!origin) return false;
    try {
      return new URL(origin).origin === this.appOrigin;
    } catch {
      return false;
    }
  }
}
