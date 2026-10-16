import createClient, { type Client, type Middleware } from 'openapi-fetch';
import { networkError, toApiError } from './errors.ts';
import type { paths } from './schema.d.ts';

export type ApiClient = Client<paths>;

export interface CreateApiClientOptions {
  /** API origin, e.g. `http://localhost:4000` (no trailing slash; paths already start with /v1). */
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Turns every non-2xx response into a thrown ApiError carrying the problem+json body. */
const throwOnError: Middleware = {
  async onResponse({ response }) {
    if (response.ok) return undefined;
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      body = undefined;
    }
    throw toApiError(response.status, body, response.headers.get('x-request-id'));
  },
  onError({ error }) {
    throw error instanceof Error && error.name === 'ApiError' ? error : networkError(error);
  },
};

/**
 * Typed API client (openapi-fetch over the generated schema). Cookies are sent (`credentials: 'include'`) for
 * session auth (BF-010). Methods resolve with `{ data }` on success and throw ApiError otherwise.
 */
export function createApiClient(options: CreateApiClientOptions): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    credentials: 'include',
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  client.use(throwOnError);
  return client;
}
