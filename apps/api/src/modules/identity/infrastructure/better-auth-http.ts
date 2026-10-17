import { AUTH_BASE_PATH } from '@bf/auth';
import { toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import { clientIp, trustedProxyMatcher } from '../../platform/security/client-ip.ts';
import type { Auth } from './better-auth.provider.ts';

/**
 * Better Auth endpoints the dashboard may call directly (paths below /api/auth). Everything that changes
 * memberships or API keys goes through our REST API instead, so the domain rules (last owner, who may grant
 * which role, no permission escalation) cannot be bypassed by calling Better Auth's own endpoints.
 */
export const ALLOWED_AUTH_PATHS: readonly (string | RegExp)[] = [
  '/ok',
  '/error',
  '/sign-up/email',
  '/sign-in/email',
  '/sign-in/social',
  /^\/callback\/[a-z0-9-]+$/,
  '/sign-out',
  '/get-session',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/verify-email',
  '/send-verification-email',
  '/request-password-reset',
  '/reset-password',
  /^\/reset-password\/[^/]+$/,
  '/change-password',
  '/update-user',
  /^\/two-factor\/[a-z-]+$/,
  // The client portal's sign-in (BF-062): links are only sent to portal-only accounts (packages/auth).
  '/sign-in/magic-link',
  '/magic-link/verify',
  '/organization/create',
  '/organization/check-slug',
  '/organization/list',
  '/organization/set-active',
  '/organization/get-invitation',
  '/organization/accept-invitation',
  '/organization/reject-invitation',
  '/organization/list-user-invitations',
];

export function isAllowedAuthPath(path: string): boolean {
  return ALLOWED_AUTH_PATHS.some((allowed) =>
    typeof allowed === 'string' ? allowed === path : allowed.test(path),
  );
}

/**
 * Better Auth keys rate limits on X-Forwarded-For: rewrite it to the client address we trust (see `clientIp`), so
 * clients cannot pick their own bucket and requests without the header do not all share one.
 */
export function pinClientIp(
  req: Pick<Request, 'headers' | 'socket'>,
  isTrustedProxy: (ip: string) => boolean,
): void {
  const client = clientIp(req, isTrustedProxy);
  if (client) req.headers['x-forwarded-for'] = client;
  else delete req.headers['x-forwarded-for'];
}

/** Express middleware serving /api/auth/* with Better Auth; must run before any body parser. */
export function betterAuthMiddleware(auth: Auth, trustedProxies: readonly string[] = []) {
  const handler = toNodeHandler(auth);
  const prefix = `${AUTH_BASE_PATH}/`;
  const isTrustedProxy = trustedProxyMatcher(trustedProxies);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith(prefix)) {
      next();
      return;
    }
    pinClientIp(req, isTrustedProxy);
    if (!isAllowedAuthPath(req.path.slice(AUTH_BASE_PATH.length))) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Not found' });
      return;
    }
    void handler(req, res);
  };
}
