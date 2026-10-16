import { BlockList, isIP } from 'node:net';
import { AUTH_BASE_PATH } from '@bf/auth';
import { toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
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

/** `AUTH_TRUSTED_PROXIES` (IPs or CIDRs) as a matcher. */
export function trustedProxyMatcher(proxies: readonly string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const entry of proxies) {
    const [address = '', bits] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(bits), family);
  }
  return (ip) => {
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  };
}

const normalizeIp = (ip: string) => ip.trim().replace(/^::ffff:/, '');

/**
 * Better Auth keys rate limits on X-Forwarded-For. Rewrite it to the one client address we trust: walking back from
 * the socket peer, skip `AUTH_TRUSTED_PROXIES` hops and keep the first address that is not one. Entries added by
 * the client itself (left of the last untrusted hop) are ignored, so clients cannot pick their own bucket; and
 * requests without the header get their peer address instead of all sharing one bucket.
 */
export function pinClientIp(
  req: Pick<Request, 'headers' | 'socket'>,
  isTrustedProxy: (ip: string) => boolean,
): void {
  const peer = normalizeIp(req.socket.remoteAddress ?? '');
  if (!peer) {
    delete req.headers['x-forwarded-for'];
    return;
  }
  const header = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map(normalizeIp)
    .filter((hop) => isIP(hop) !== 0);
  let client = peer;
  while (isTrustedProxy(client) && hops.length > 0) client = hops.pop() as string;
  req.headers['x-forwarded-for'] = client;
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
