import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  request as playwrightRequest,
} from '@playwright/test';
import { apiUrl, webUrl } from './env.ts';
import { linkFromEmail } from './mailpit.ts';

export interface E2eUser {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

let ip = (Date.now() + process.pid) % 250;

/**
 * A fresh client IP (TEST-NET-2), sent as X-Forwarded-For: the e2e API trusts loopback as its reverse proxy, so
 * each test gets its own Better Auth rate-limit buckets instead of all browsers sharing 127.0.0.1's.
 */
export const nextClientIp = () => `198.51.100.${(ip++ % 250) + 1}`;

/** Headers a browser would send: the app's Origin (CSRF check) and, behind the proxy, its own client IP. */
export const browserHeaders = () => ({ Origin: webUrl, 'X-Forwarded-For': nextClientIp() });

/**
 * Signs a new user up through the API, follows the verification link from Mailpit and signs in: `request` then
 * holds their session cookie. Optionally creates workspaces (the first becomes active).
 */
export async function createVerifiedUser(
  request: APIRequestContext,
  prefix: string,
  workspaces: readonly string[] = [],
): Promise<E2eUser> {
  const user = {
    email: `e2e-${prefix}-${Date.now()}@example.test`,
    password: `${prefix} long e2e passphrase`,
    name: 'Olive Owner',
  };
  const headers = browserHeaders();
  await expect(await request.post(`${apiUrl}/api/auth/sign-up/email`, { data: user, headers })).toBeOK();
  await request.get(await linkFromEmail(request, user.email, '/api/auth/verify-email'), { headers });
  const signIn = await request.post(`${apiUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password },
    headers,
  });
  await expect(signIn).toBeOK();
  const ids: string[] = [];
  for (const name of workspaces) {
    const created = await request.post(`${apiUrl}/api/auth/organization/create`, {
      data: { name, slug: `${name.toLowerCase().replaceAll(' ', '-')}-${Date.now()}` },
      headers,
    });
    await expect(created).toBeOK();
    ids.push(((await created.json()) as { id: string }).id);
  }
  // Creating a workspace also makes it active; end on the first one.
  if (ids[0]) {
    await expect(
      await request.post(`${apiUrl}/api/auth/organization/set-active`, {
        data: { organizationId: ids[0] },
        headers,
      }),
    ).toBeOK();
  }
  return user;
}

/**
 * A page signed in as a brand-new user. For specs that change account or session state (2FA, active workspace),
 * which would otherwise race with the specs sharing the owner's session.
 */
export async function signedInAsNewUser(
  browser: Browser,
  prefix: string,
  workspaces: readonly string[],
): Promise<{ page: Page; user: E2eUser; close: () => Promise<void> }> {
  const request = await playwrightRequest.newContext();
  const user = await createVerifiedUser(request, prefix, workspaces);
  const context = await browser.newContext({
    storageState: await request.storageState(),
    extraHTTPHeaders: { 'X-Forwarded-For': nextClientIp() },
  });
  await request.dispose();
  return { page: await context.newPage(), user, close: () => context.close() };
}
