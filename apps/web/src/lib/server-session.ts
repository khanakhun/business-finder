import 'server-only';
import type { IdentityConfig, Me } from '@bf/contracts';
import { headers } from 'next/headers';

const apiUrl = () => process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The signed-in user as the API sees them (`GET /v1/me` with the browser's cookies), or null when signed out.
 * The API is the authority: the dashboard never decides access on its own.
 */
export async function getSession(): Promise<Me | null> {
  const cookie = (await headers()).get('cookie');
  if (!cookie) return null;
  const response = await fetch(`${apiUrl()}/v1/me`, { headers: { cookie }, cache: 'no-store' });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`GET /v1/me failed with ${response.status}`);
  return (await response.json()) as Me;
}

/** Which sign-in/sign-up options the API offers (public endpoint, cached briefly). */
export async function getIdentityConfig(): Promise<IdentityConfig> {
  const response = await fetch(`${apiUrl()}/v1/identity/config`, { next: { revalidate: 60 } });
  if (!response.ok) throw new Error(`GET /v1/identity/config failed with ${response.status}`);
  return (await response.json()) as IdentityConfig;
}
