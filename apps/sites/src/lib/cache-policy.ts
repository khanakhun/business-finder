/** How long a site's lookup is reused without a revalidation. */
export const TENANT_TTL_MS = 60_000;
/** An unknown host is looked up again soon (publishing it revalidates `host:<name>` anyway). */
export const UNKNOWN_TTL_MS = 10_000;
/** A site whose spec cannot be rendered (a newer schema than this renderer) is retried after this. */
export const FAILURE_TTL_MS = 30_000;
/** The longest a lookup may take (the connection timeout is 3 s): a hanging database answers 503, not later. */
export const LOOKUP_DEADLINE_MS = 3_500;
/** After a failed lookup, the database counts as down this long: requests are answered at once, not queued. */
export const DOWN_FOR_MS = 5_000;
/** While the database is unreachable, the last known site is served this much longer (never past its expiry). */
export const STALE_GRACE_MS = 10 * 60_000;

/**
 * Until when a lookup may be served: a while, but never past the preview's expiry (an expired preview must turn
 * into its 410 page on time, before the hourly job even runs).
 */
export function cacheUntil(
  tenant: { readonly status: string; readonly expiresAt: string | null } | null,
  now: number,
  ttlMs: number = tenant ? TENANT_TTL_MS : UNKNOWN_TTL_MS,
): number {
  const expiry =
    tenant?.status === 'active' && tenant.expiresAt ? Date.parse(tenant.expiresAt) : Number.POSITIVE_INFINITY;
  return Math.min(now + ttlMs, expiry);
}
