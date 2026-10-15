import { type Auth, createAuth } from '@bf/auth';
import type { ApiEnv } from '@bf/config';
import type { DbClient } from '@bf/db';
import type { Provider } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import {
  IDENTITY_EVENTS,
  type IdentityEvents,
  SYSTEM_MAILER,
  type SystemMailer,
} from '../application/ports.ts';

export const BETTER_AUTH = Symbol('BETTER_AUTH');
export type { Auth };

/** The one Better Auth instance of the API process (identity module only; the worker has none). */
export const betterAuthProvider: Provider = {
  provide: BETTER_AUTH,
  inject: [APP_ENV, DB_CLIENT, SYSTEM_MAILER, IDENTITY_EVENTS],
  useFactory: (appEnv: AppEnv, db: DbClient, mailer: SystemMailer, events: IdentityEvents): Auth => {
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
        // DECISION(BF-010): invite-only by default in production (internal tool), open elsewhere.
        mode: env.SIGNUP_MODE ?? (production ? 'invite_only' : 'open'),
        allowedEmailDomains: env.SIGNUP_ALLOWED_EMAIL_DOMAINS,
      },
      mailer,
      // Never call out to haveibeenpwned.com from tests.
      breachedPasswordCheck: env.AUTH_CHECK_PWNED && env.NODE_ENV !== 'test',
      onEvent: async (event) => {
        if (event.type === 'identity.user_signed_up') {
          await events.publish({ type: event.type, userId: event.userId }, { userId: event.userId });
        }
      },
    });
  },
};
