// Typed Better Auth client for the dashboard (apps/web). It talks to the API's /api/auth/* with cookies; the
// server instance (server.ts) is imported for types only, so none of it reaches the browser bundle.
import { apiKeyClient } from '@better-auth/api-key/client';
import { inferAdditionalFields, organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { AUTH_BASE_PATH } from './constants.ts';
import { ac, roles } from './roles.ts';
import type { Auth } from './server.ts';

export function createBfAuthClient(apiUrl: string, options: { onTwoFactorRedirect?: () => void } = {}) {
  return createAuthClient({
    baseURL: apiUrl,
    basePath: AUTH_BASE_PATH,
    fetchOptions: { credentials: 'include' },
    plugins: [
      inferAdditionalFields<Auth>(),
      organizationClient({ ac, roles }),
      twoFactorClient(
        options.onTwoFactorRedirect ? { onTwoFactorRedirect: options.onTwoFactorRedirect } : {},
      ),
      apiKeyClient(),
    ],
  });
}

export type BfAuthClient = ReturnType<typeof createBfAuthClient>;
