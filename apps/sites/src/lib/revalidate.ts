import {
  INTERNAL_AUTH_MAX_SKEW_SECONDS,
  SiteRevalidateRequestSchema,
  verifyInternalRequest,
} from '@bf/contracts';
import { NonceCache } from './nonce-cache.ts';

export const REVALIDATE_PATH = '/api/revalidate';

export interface RevalidateDeps {
  readonly secret: string | undefined;
  readonly nonces: NonceCache;
  readonly invalidate: (tags: readonly string[]) => number;
  readonly now?: number;
}

/**
 * `POST /api/revalidate` from the API (BF-035): signed like every internal call (method, path and body), within the
 * clock skew, never twice; the body names the cache tags to drop (`site:<id>`, `host:<hostname>`).
 */
export async function revalidate(
  request: { readonly authorization: string | null; readonly path: string; readonly body: string },
  deps: RevalidateDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!deps.secret) return { status: 503, body: { error: 'revalidation is not configured' } };
  const now = deps.now ?? Date.now();
  const auth = await verifyInternalRequest(
    request.authorization,
    { method: 'POST', path: request.path, body: request.body },
    { secret: deps.secret, now: Math.floor(now / 1000) },
  );
  if (!auth.ok) return { status: 401, body: { error: auth.reason } };
  if (!deps.nonces.use(auth.nonce, now)) return { status: 409, body: { error: 'replayed' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }
  const result = SiteRevalidateRequestSchema.safeParse(parsed);
  if (!result.success) return { status: 400, body: { error: 'invalid tags' } };
  return { status: 200, body: { revalidated: deps.invalidate(result.data.tags), tags: result.data.tags } };
}

/** Replays are refused for as long as a signature's timestamp is accepted (both sides of the skew). */
export const revalidateNonces = () => new NonceCache(2 * INTERNAL_AUTH_MAX_SKEW_SECONDS * 1000);
