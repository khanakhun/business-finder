// Better Auth configured once for the whole system (ADR-0007). The API mounts `auth.handler` at /api/auth/* and
// resolves sessions/API keys in its guard; nothing else instantiates Better Auth except the bootstrap CLI.
import { apiKey } from '@better-auth/api-key';
import { type Locale, newId } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { haveIBeenPwned, magicLink, organization, twoFactor } from 'better-auth/plugins';
import { API_KEY_PREFIX, AUTH_BASE_PATH, MIN_PASSWORD_LENGTH } from './constants.ts';
import { portalSignInAllowed } from './portal-store.ts';
import { ac, roles } from './roles.ts';
import { defaultOrganizationId } from './session-defaults.ts';
import type { SignupPolicy } from './signup.ts';
import { signupAllowed } from './signup-store.ts';

const DAY_SECONDS = 24 * 60 * 60;

/** System emails sent by the auth flows (verification, reset, invitation, 2FA notice) — never prospect mail. */
export interface AuthMailer {
  sendVerificationEmail(input: { to: string; name: string; url: string; locale: Locale }): Promise<void>;
  sendPasswordReset(input: { to: string; name: string; url: string; locale: Locale }): Promise<void>;
  sendInvitation(input: {
    to: string;
    inviterName: string;
    organizationName: string;
    role: string;
    url: string;
    locale: Locale;
  }): Promise<void>;
  sendTwoFactorEnabled(input: { to: string; name: string; locale: Locale }): Promise<void>;
  /** The client portal's sign-in link (BF-062). */
  sendMagicLink(input: { to: string; url: string; locale: Locale }): Promise<void>;
}

/** Identity events raised inside Better Auth; the API records them in its outbox (BF-012). */
export type AuthEvent =
  | { type: 'identity.user_signed_up'; userId: string; email: string }
  | { type: 'identity.member_joined'; organizationId: string; memberId: string; userId: string; role: string }
  | {
      type: 'identity.member_invited';
      organizationId: string;
      invitationId: string;
      role: string;
      inviterId: string;
    };

export interface CreateAuthOptions {
  readonly db: DbClient;
  readonly secret: string;
  /** Public URL of the API (where /api/auth/* lives). */
  readonly apiUrl: string;
  /** Public URL of the dashboard: trusted origin, and where email links land. */
  readonly appUrl: string;
  /** Parent domain shared by app. and api. (e.g. `example.com`); unset = host-only cookies (local dev). */
  readonly cookieDomain?: string | undefined;
  readonly secureCookies: boolean;
  readonly google?: { readonly clientId: string; readonly clientSecret: string } | undefined;
  readonly signup: SignupPolicy;
  readonly mailer: AuthMailer;
  /** Rejects passwords found in known breaches (k-anonymity range queries to haveibeenpwned.com). */
  readonly breachedPasswordCheck: boolean;
  /** Auth endpoint rate limits; tests turn them off except where they test them. */
  readonly rateLimit?: boolean;
  readonly onEvent?: (event: AuthEvent) => void | Promise<void>;
  /**
   * Whether `userId` may create another workspace (Better Auth's /organization/create). Defaults to no one, so
   * the caller must decide (the API allows it per sign-up policy).
   */
  readonly allowWorkspaceCreation?: (userId: string) => Promise<boolean>;
  /**
   * Per-account sign-in throttle, on top of the per-IP limit: return false to refuse an attempt for this
   * (lower-cased) email. Protects accounts when many IPs are used, and keeps a shared IP from locking everyone out.
   */
  readonly signInThrottle?: (email: string) => Promise<boolean>;
  /** Reverse proxies whose X-Forwarded-For hops are skipped to find the client IP (rate limits, sessions). */
  readonly trustedProxies?: readonly string[];
  /** Where Better Auth's own log lines go (warn and above: its info lines contain email addresses). */
  readonly log?: (level: 'warn' | 'error', message: string, ...args: unknown[]) => void;
}

/** Users carry the `locale` additional field; Better Auth's base user type does not declare it. */
const localeOf = (user: object): Locale => ('locale' in user && user.locale === 'fr' ? 'fr' : 'en');

export function createAuth(options: CreateAuthOptions) {
  const { mailer, appUrl } = options;
  const emit = async (event: AuthEvent) => options.onEvent?.(event);

  return betterAuth({
    appName: 'Business Finder',
    logger: {
      level: 'warn',
      ...(options.log
        ? {
            log: (level, message, ...args) =>
              options.log?.(level === 'error' ? 'error' : 'warn', message, ...args),
          }
        : {}),
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if ((ctx.path !== '/sign-in/email' && ctx.path !== '/sign-in/magic-link') || !options.signInThrottle)
          return;
        const email = typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
        if (email && !(await options.signInThrottle(email))) {
          throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many sign-in attempts. Try again later.' });
        }
      }),
    },
    secret: options.secret,
    baseURL: options.apiUrl,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [appUrl],
    database: drizzleAdapter(options.db, { provider: 'pg' }),
    user: {
      // Who may get an account (SIGNUP_MODE), for every method (email/password, Google). Rejections are 403s.
      validateUserInfo: async ({ user, source }) => {
        if (source.action !== 'create-user') return;
        const email = typeof user.email === 'string' ? user.email : '';
        if (!(await signupAllowed(options.db, options.signup, email))) {
          return { error: 'signup_closed', errorDescription: 'Sign-up is closed for this email address.' };
        }
      },
      additionalFields: {
        // UI and system-email language; DOMAIN.md: EN/FR.
        locale: { type: 'string', required: false, defaultValue: 'en', input: true },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 256,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        const url = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
        await mailer.sendPasswordReset({ to: user.email, name: user.name, url, locale: localeOf(user) });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: DAY_SECONDS,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.sendVerificationEmail({ to: user.email, name: user.name, url, locale: localeOf(user) });
      },
    },
    ...(options.google
      ? {
          socialProviders: {
            google: { clientId: options.google.clientId, clientSecret: options.google.clientSecret },
          },
        }
      : {}),
    session: {
      expiresIn: 7 * DAY_SECONDS, // sliding: refreshed at most once a day while in use
      updateAge: DAY_SECONDS,
      // No cookie cache: revoking a session (sign-out elsewhere, password reset) must take effect immediately.
      cookieCache: { enabled: false },
    },
    account: { accountLinking: { enabled: true, trustedProviders: ['google'] } },
    rateLimit: {
      enabled: options.rateLimit ?? true,
      // Shared across API instances (the default in-memory store is per process).
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 5 },
        '/two-factor/*': { window: 60, max: 10 },
        '/sign-in/magic-link': { window: 60, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: 'bf',
      ipAddress: {
        ipAddressHeaders: ['x-forwarded-for'],
        trustedProxies: [...(options.trustedProxies ?? [])],
      },
      useSecureCookies: options.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: options.secureCookies },
      ...(options.cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: options.cookieDomain } }
        : {}),
      // UUIDv7 like every other table (AGENTS.md §6).
      database: { generateId: () => newId() },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            if (session.activeOrganizationId) return { data: session };
            return {
              data: {
                ...session,
                activeOrganizationId: await defaultOrganizationId(options.db, session.userId),
              },
            };
          },
        },
      },
      user: {
        create: {
          after: async (user) =>
            emit({ type: 'identity.user_signed_up', userId: user.id, email: user.email }),
        },
        update: {
          before: async (data, ctx) => {
            // Notify on the switch to 2FA (the verify-totp step sets the flag).
            const session = ctx?.context.session;
            if (data.twoFactorEnabled === true && session && !session.user.twoFactorEnabled) {
              const user = session.user;
              await mailer.sendTwoFactorEnabled({ to: user.email, name: user.name, locale: localeOf(user) });
            }
            return { data };
          },
        },
      },
    },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: 'owner',
        allowUserToCreateOrganization: async (user) =>
          (await options.allowWorkspaceCreation?.(user.id)) ?? false,
        organizationLimit: 10,
        invitationExpiresIn: 7 * DAY_SECONDS,
        cancelPendingInvitationsOnReInvite: true,
        requireEmailVerificationOnInvitation: true,
        organizationHooks: {
          afterAcceptInvitation: async ({ member, user, organization: org }) => {
            await emit({
              type: 'identity.member_joined',
              organizationId: org.id,
              memberId: member.id,
              userId: user.id,
              role: member.role,
            });
          },
        },
        sendInvitationEmail: async ({ id, email, role, organization: org, inviter }) => {
          await mailer.sendInvitation({
            to: email,
            inviterName: inviter.user.name,
            organizationName: org.name,
            role,
            url: `${appUrl}/invite/${id}`,
            locale: localeOf(inviter.user),
          });
          await emit({
            type: 'identity.member_invited',
            organizationId: org.id,
            invitationId: id,
            role,
            inviterId: inviter.user.id,
          });
        },
      }),
      twoFactor({ issuer: 'Business Finder' }),
      // The client portal (BF-062). The answer is the same whether or not a link was sent (no account probing).
      magicLink({
        expiresIn: 15 * 60,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url, metadata }) => {
          if (!(await portalSignInAllowed(options.db, email))) return;
          await mailer.sendMagicLink({ to: email, url, locale: metadata?.locale === 'en' ? 'en' : 'fr' });
        },
      }),
      apiKey({
        references: 'organization',
        defaultPrefix: API_KEY_PREFIX,
        enableMetadata: true,
        requireName: true,
        // Request limits come from the API's throttler, not per key.
        rateLimit: { enabled: false },
      }),
      ...(options.breachedPasswordCheck ? [haveIBeenPwned()] : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
