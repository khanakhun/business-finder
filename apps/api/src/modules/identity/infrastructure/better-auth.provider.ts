import { createHash } from 'node:crypto';
import { type Auth, createAuth } from '@bf/auth';
import type { ApiEnv } from '@bf/config';
import { RoleSchema } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import type { Logger } from '@bf/observability';
import type { Provider } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import {
  IDENTITY_EVENTS,
  type IdentityEvents,
  MEMBERSHIP_REPOSITORY,
  type MembershipRepository,
  SYSTEM_MAILER,
  type SystemMailer,
} from '../application/ports.ts';

/** Sign-in attempts allowed per account per window, across all IPs (the per-IP limit is separate). */
export const SIGN_IN_ATTEMPTS_PER_ACCOUNT = 20;
const SIGN_IN_WINDOW_SECONDS = 15 * 60;

/** Counts sign-in attempts per (hashed) email in Valkey. Fails open, like the API throttler (BF-006). */
function valkeySignInThrottle(valkey: Redis, logger: Logger) {
  return async (email: string): Promise<boolean> => {
    const key = `bf:auth:sign-in:${createHash('sha256').update(email).digest('hex')}`;
    try {
      const attempts = await valkey.incr(key);
      if (attempts === 1) await valkey.expire(key, SIGN_IN_WINDOW_SECONDS);
      return attempts <= SIGN_IN_ATTEMPTS_PER_ACCOUNT;
    } catch (error) {
      logger.warn({ err: error }, 'sign-in throttle unavailable, allowing attempt');
      return true;
    }
  };
}

export const BETTER_AUTH = Symbol('BETTER_AUTH');

// DECISION(BF-010): invite-only by default in production (internal tool), open elsewhere.
// BF-062: public sign-up in production also needs FEATURE_SELF_SERVE_SIGNUP (the SaaS readiness gaps are not
// closed): the API refuses to start otherwise rather than quietly opening or closing sign-up.
export const signupModeOf = (env: ApiEnv) => {
  const mode = env.SIGNUP_MODE ?? (env.NODE_ENV === 'production' ? 'invite_only' : 'open');
  if (mode === 'open' && env.NODE_ENV === 'production' && !env.FEATURE_SELF_SERVE_SIGNUP)
    throw new Error(
      'SIGNUP_MODE=open needs FEATURE_SELF_SERVE_SIGNUP=true in production (see docs/product/saas-readiness.md).',
    );
  return mode;
};
export type { Auth };

/** The one Better Auth instance of the API process (identity module only; the worker has none). */
export const betterAuthProvider: Provider = {
  provide: BETTER_AUTH,
  inject: [APP_ENV, DB_CLIENT, SYSTEM_MAILER, IDENTITY_EVENTS, MEMBERSHIP_REPOSITORY, VALKEY, LOGGER],
  useFactory: (
    appEnv: AppEnv,
    db: DbClient,
    mailer: SystemMailer,
    events: IdentityEvents,
    members: MembershipRepository,
    valkey: Redis,
    logger: Logger,
  ): Auth => {
    const env = appEnv as ApiEnv;
    const production = env.NODE_ENV === 'production';
    return createAuth({
      db,
      secret: env.BETTER_AUTH_SECRET,
      apiUrl: env.API_URL,
      appUrl: env.APP_URL,
      cookieDomain: env.AUTH_COOKIE_DOMAIN,
      secureCookies: production || env.API_URL.startsWith('https://'),
      google:
        env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
          : undefined,
      signup: {
        mode: signupModeOf(env),
        allowedEmailDomains: env.SIGNUP_ALLOWED_EMAIL_DOMAINS,
      },
      mailer,
      // Never call out to haveibeenpwned.com from tests.
      breachedPasswordCheck: env.AUTH_CHECK_PWNED && env.NODE_ENV !== 'test',
      trustedProxies: env.AUTH_TRUSTED_PROXIES,
      signInThrottle: valkeySignInThrottle(valkey, logger),
      // DECISION(BF-010): with open/allowlist sign-up anyone may create a workspace; invite-only deployments
      // limit it to existing owners (an invited member cannot spin up workspaces of their own).
      allowWorkspaceCreation: async (userId) =>
        signupModeOf(env) !== 'invite_only' ||
        (await members.organizationsOf(userId)).some((org) => org.role === 'owner'),
      log: (level, message, ...args) => logger[level]({ args }, `better-auth: ${message}`),
      onEvent: async (event) => {
        if (event.type === 'identity.user_signed_up') {
          await events.publish({ type: event.type, userId: event.userId }, { userId: event.userId });
        }
        if (event.type === 'identity.member_joined') {
          const role = RoleSchema.safeParse(event.role);
          if (!role.success) return;
          await events.publish(
            {
              type: event.type,
              organizationId: event.organizationId,
              memberId: event.memberId,
              userId: event.userId,
              role: role.data,
            },
            { userId: event.userId },
          );
        }
      },
    });
  },
};
