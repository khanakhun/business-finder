import type { SiteSpec } from '@bf/site-schema';
import {
  cacheUntil,
  DOWN_FOR_MS,
  FAILURE_TTL_MS,
  LOOKUP_DEADLINE_MS,
  STALE_GRACE_MS,
  UNKNOWN_TTL_MS,
} from './cache-policy.ts';
import { errorFields, log } from './log.ts';
import { TagCache } from './tag-cache.ts';

/** What the renderer knows about a hostname: its latest publication, the site when it is active. */
export interface Tenant {
  readonly hostname: string;
  readonly siteId: string;
  readonly status: 'active' | 'expired' | 'unpublished';
  readonly environment: 'preview' | 'live';
  readonly businessName: string;
  readonly agencyName: string;
  readonly agencyUrl: string | null;
  readonly noindex: boolean;
  readonly expiresAt: string | null;
  /** The site, only while its publication is active. */
  readonly spec: SiteSpec | null;
  /** Responsive sources of the site's processed images, by public URL. */
  readonly images: Readonly<Record<string, string>>;
}

/** The site cannot be served now: the database is unreachable, or its spec is newer than this renderer. */
export class TenantUnavailableError extends Error {
  override readonly name = 'TenantUnavailableError';
}

/** The query, or a timeout error past `LOOKUP_DEADLINE_MS` (a hanging database never holds a request longer). */
export function withDeadline<T>(work: Promise<T>, ms: number = LOOKUP_DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('site lookup timed out')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export interface TenantStore {
  /** The tenant of a hostname; throws `TenantUnavailableError` when it cannot be known now (the caller answers 503). */
  get(hostname: string): Promise<Tenant | null>;
  /** Drops what carries one of the tags (the API's revalidation); returns how many entries. */
  invalidate(tags: readonly string[]): number;
}

/**
 * The renderer's view of its sites (cache-aside, tagged `host:<hostname>` and `site:<id>`): known sites and unknown
 * hosts cached apart (a flood of random subdomains never pushes real sites out), lookups in flight shared, the last
 * known site served while the database is down (never past its expiry), a short "down" window so no request queues
 * on a hanging database, unreadable specs remembered briefly, and answers from before a revalidation never kept.
 */
export function createTenantStore(
  load: (hostname: string) => Promise<Tenant | null>,
  clock: () => number = Date.now,
): TenantStore {
  /** Known sites (bounded: specs are up to 750 kB each). */
  const cache = new TagCache<Tenant>(500);
  const unknown = new TagCache<null>(500);
  /** The last site served per host, for a database outage. */
  const lastKnown = new TagCache<Tenant>(500);
  /** Hosts whose spec could not be read, for a while (each request would fail the same way). */
  const failures = new TagCache<true>(200);
  const inFlight = new Map<string, Promise<Tenant | null>>();
  /** Bumped by each revalidation: a lookup that started before it never stores its (possibly older) answer. */
  let generation = 0;
  /** Until when the database counts as down (a lookup failed): requests are answered at once, not queued. */
  let downUntil = 0;

  const unavailable = (hostname: string) =>
    new TenantUnavailableError(`The site of ${hostname} is unavailable.`);

  async function lookup(hostname: string, now: number): Promise<Tenant | null> {
    const started = generation;
    // Revalidated meanwhile: the answer may predate the change, so it is returned but not kept.
    const current = () => generation === started;
    try {
      const tenant = await load(hostname);
      if (!tenant) {
        if (current()) unknown.set(hostname, null, now + UNKNOWN_TTL_MS, [`host:${hostname}`]);
        return null;
      }
      const tags = [`host:${hostname}`, `site:${tenant.siteId}`];
      if (current()) {
        cache.set(hostname, tenant, cacheUntil(tenant, now), tags);
        lastKnown.set(hostname, tenant, cacheUntil(tenant, now, STALE_GRACE_MS), tags);
      }
      return tenant;
    } catch (error) {
      if (error instanceof TenantUnavailableError) {
        failures.set(hostname, true, now + FAILURE_TTL_MS, [`host:${hostname}`]);
        throw error;
      }
      // The database is unreachable: for a few seconds no request waits for it, and the last known site is served
      // until its grace (or its expiry) ends.
      downUntil = clock() + DOWN_FOR_MS;
      const stale = lastKnown.get(hostname, now);
      log(stale ? 'warn' : 'error', 'site lookup failed', {
        hostname,
        servedStale: Boolean(stale),
        ...errorFields(error),
      });
      if (stale) return stale;
      throw unavailable(hostname);
    }
  }

  return {
    async get(hostname) {
      const now = clock();
      const hit = cache.get(hostname, now) ?? unknown.get(hostname, now);
      if (hit !== undefined) return hit;
      if (failures.get(hostname, now)) throw unavailable(hostname);
      if (now < downUntil) {
        const stale = lastKnown.get(hostname, now);
        if (stale) return stale;
        throw unavailable(hostname);
      }
      const pending = inFlight.get(hostname);
      if (pending) return pending;
      const promise = lookup(hostname, now).finally(() => {
        if (inFlight.get(hostname) === promise) inFlight.delete(hostname);
      });
      inFlight.set(hostname, promise);
      return promise;
    },
    invalidate(tags) {
      generation += 1;
      // Lookups already running started before the change: new requests start their own.
      inFlight.clear();
      const dropped = cache.invalidate(tags) + unknown.invalidate(tags);
      // An unpublished site is never served again, not even during a later database outage.
      failures.invalidate(tags);
      lastKnown.invalidate(tags);
      log('info', 'sites revalidated', { tags, dropped });
      return dropped;
    },
  };
}
