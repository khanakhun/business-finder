import 'server-only';
import { headers } from 'next/headers';
import { cache } from 'react';

const apiUrl = () => process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type ServerFetchResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number };

/**
 * A GET on the API from a server component with the browser's cookies (the API decides access). Deduplicated per
 * request, so `generateMetadata` and the page share one call. Never throws on HTTP errors: pages decide (404 →
 * `notFound()`, anything else → let the client fetch and show its error state).
 */
export const serverGet = cache(async <T>(path: string): Promise<ServerFetchResult<T>> => {
  const cookie = (await headers()).get('cookie');
  if (!cookie) return { ok: false, status: 401 };
  try {
    const response = await fetch(`${apiUrl()}${path}`, {
      headers: { cookie },
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
