import 'server-only';
import { headers } from 'next/headers';
import { cache } from 'react';
import { serverPublicEnv } from './public-env.ts';

/** The API from the web server: `API_INTERNAL_URL` (internal network), else its public URL. */
export const serverApiUrl = () =>
  process.env.API_INTERNAL_URL ?? process.env.API_URL ?? serverPublicEnv().apiUrl;

/**
 * Headers of a server-side call on the visitor's behalf: their session cookie, and their address as the proxy in
 * front of us reported it (the API trusts this server as a proxy, so rate limits and audit logs see the visitor).
 */
export function forwardedHeaders(incoming: Headers): Record<string, string> {
  const forwarded = incoming.get('x-forwarded-for');
  return {
    cookie: incoming.get('cookie') ?? '',
    ...(forwarded ? { 'x-forwarded-for': forwarded } : {}),
  };
}

export type ServerFetchResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number };

/**
 * A GET on the API from a server component with the browser's cookies (the API decides access). Deduplicated per
 * request, so `generateMetadata` and the page share one call. Never throws on HTTP errors: pages decide (404 →
 * `notFound()`, anything else → let the client fetch and show its error state).
 */
export const serverGet = cache(async <T>(path: string): Promise<ServerFetchResult<T>> => {
  const incoming = await headers();
  if (!incoming.get('cookie')) return { ok: false, status: 401 };
  try {
    const response = await fetch(`${serverApiUrl()}${path}`, {
      headers: forwardedHeaders(incoming),
      cache: 'no-store',
      // A hung API must not hold the page: the client fetches and shows its own state instead.
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, status: 0 };
  }
});
