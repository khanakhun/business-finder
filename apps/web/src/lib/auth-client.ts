'use client';

import { type BfAuthClient, createBfAuthClient } from '@bf/auth/client';
import { publicEnv } from './public-env.ts';

let client: BfAuthClient | undefined;

/** Better Auth client (sign-in, sign-up, 2FA, workspace switching). Imported only by pages that need it. */
export function authClient(): BfAuthClient {
  client ??= createBfAuthClient(publicEnv().apiUrl, {
    onTwoFactorRedirect: () => {
      const next = new URLSearchParams(window.location.search).get('next');
      window.location.assign(`/two-factor${next ? `?next=${encodeURIComponent(next)}` : ''}`);
    },
  });
  return client;
}

interface AuthClientError {
  readonly message?: string | undefined;
  readonly code?: string | undefined;
  readonly status?: number | undefined;
}

/** Better Auth answers errors as `{ error: { message, code, status } }`; this turns them into a thrown Error. */
export async function unwrap<R extends { data: unknown; error: unknown }>(
  result: Promise<R>,
): Promise<NonNullable<R['data']>> {
  const { data, error } = await result;
  if (error) {
    const { message, code, status } = error as AuthClientError;
    throw Object.assign(new Error(message ?? 'Request failed'), { code, status });
  }
  return data as NonNullable<R['data']>;
}
