import 'server-only';
import { createDb, type DbClient } from '@bf/db/client';
import { rendererPublishedSites, rendererSiteAssets } from '@bf/db/read-models';
import { migrateSpec, type SiteSpec } from '@bf/site-schema';
import { eq } from 'drizzle-orm';
import { cacheUntil, FAILURE_TTL_MS, STALE_GRACE_MS, UNKNOWN_TTL_MS } from './cache-policy.ts';
import { sitesEnvironment } from './env.ts';
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

interface Shared {
  db?: DbClient;
  /** Known sites (bounded: specs are up to 750 kB each). */
  cache: TagCache<Tenant>;
  /** Hosts with no publication, apart: a flood of random subdomains never pushes real sites out. */
  unknown: TagCache<null>;
  /** The last site served per host, for a database outage (never past its expiry). */
  lastKnown: TagCache<Tenant>;
  /** Hosts whose spec could not be read, for a while (each request would fail the same way). */
  failures: TagCache<true>;
  /** Lookups in flight: concurrent requests for one host share one query. */
  inFlight: Map<string, Promise<Tenant | null>>;
}

// DECISION(BF-036): one cache per process, shared through globalThis by the proxy, pages and route handlers, so the
// revalidation route clears what the proxy and the pages read (the e2e "410 after revalidation" test guards it).
// Next documents Proxy as possibly isolated; this holds for self-hosted `next start` / standalone (one process).
// With several replicas, revalidation reaches one: run one replica, or fan revalidation out (follow-up).
const SHARED = Symbol.for('bf.sites.tenants');
function shared(): Shared {
  const holder = globalThis as unknown as Record<symbol, Shared | undefined>;
  holder[SHARED] ??= {
    cache: new TagCache<Tenant>(500),
    unknown: new TagCache<null>(500),
    lastKnown: new TagCache<Tenant>(500),
    failures: new TagCache<true>(200),
    inFlight: new Map(),
  };
  return holder[SHARED];
}

function db(): DbClient {
  const state = shared();
  state.db ??= createDb({
    url: sitesEnvironment().SITES_DATABASE_URL,
    readOnly: true,
    max: 5,
    applicationName: 'bf-sites',
    statementTimeoutMs: 5_000,
    connectTimeoutSeconds: 3,
  });
  return state.db;
}

async function load(hostname: string): Promise<Tenant | null> {
  const [row] = await db()
    .select()
    .from(rendererPublishedSites)
    .where(eq(rendererPublishedSites.hostname, hostname))
    .limit(1);
  if (!row) return null;
  const active = row.status === 'active' && row.spec !== null;
  const images: Record<string, string> = {};
  if (active) {
    const assets = await db()
      .select({ publicUrl: rendererSiteAssets.publicUrl, variants: rendererSiteAssets.variants })
      .from(rendererSiteAssets)
      .where(eq(rendererSiteAssets.siteId, row.siteId));
    for (const asset of assets) {
      const webp = (asset.variants ?? []).filter((variant) => variant.format === 'webp');
      if (asset.publicUrl && webp.length > 0)
        images[asset.publicUrl] = webp.map((variant) => `${variant.url} ${variant.width}w`).join(', ');
    }
  }
  let spec: SiteSpec | null = null;
  if (active) {
    try {
      // Stored versions were validated when saved; an older schema version is upcast.
      spec = migrateSpec(row.spec);
    } catch (error) {
      // A spec of a newer schema than this renderer (deploy the renderer before the API), or a corrupt one.
      log('error', 'site spec unreadable', { hostname, siteId: row.siteId, ...errorFields(error) });
      throw new TenantUnavailableError(`The site of ${hostname} cannot be rendered.`);
    }
  }
  return {
    hostname: row.hostname,
    siteId: row.siteId,
    status: row.status,
    environment: row.environment,
    businessName: row.businessName,
    agencyName: row.agencyName,
    agencyUrl: row.agencyUrl,
    noindex: row.noindex,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    spec,
    images,
  };
}

async function lookup(hostname: string, now: number): Promise<Tenant | null> {
  const state = shared();
  try {
    const tenant = await load(hostname);
    if (!tenant) {
      state.unknown.set(hostname, null, now + UNKNOWN_TTL_MS, [`host:${hostname}`]);
      return null;
    }
    const tags = [`host:${hostname}`, `site:${tenant.siteId}`];
    state.cache.set(hostname, tenant, cacheUntil(tenant, now), tags);
    state.lastKnown.set(hostname, tenant, cacheUntil(tenant, now, STALE_GRACE_MS), tags);
    return tenant;
  } catch (error) {
    if (error instanceof TenantUnavailableError) {
      state.failures.set(hostname, true, now + FAILURE_TTL_MS, [`host:${hostname}`]);
      throw error;
    }
    // The database is unreachable: the last known site, until its grace (or its expiry) ends.
    const stale = state.lastKnown.get(hostname, now);
    log(stale ? 'warn' : 'error', 'site lookup failed', {
      hostname,
      servedStale: Boolean(stale),
      ...errorFields(error),
    });
    if (stale) return stale;
    throw new TenantUnavailableError(`The site of ${hostname} is unavailable.`);
  }
}

/**
 * The tenant of a site hostname (cache-aside, tagged `host:<hostname>` and `site:<id>`); throws
 * `TenantUnavailableError` when it cannot be known now (the caller answers 503).
 */
export async function getTenant(hostname: string): Promise<Tenant | null> {
  const state = shared();
  const now = Date.now();
  const hit = state.cache.get(hostname, now) ?? state.unknown.get(hostname, now);
  if (hit !== undefined) return hit;
  if (state.failures.get(hostname, now))
    throw new TenantUnavailableError(`The site of ${hostname} is unavailable.`);
  const pending = state.inFlight.get(hostname);
  if (pending) return pending;
  const promise = lookup(hostname, now).finally(() => state.inFlight.delete(hostname));
  state.inFlight.set(hostname, promise);
  return promise;
}

/** Drops the cached tenants carrying one of the tags (the API's revalidation). */
export function invalidateTenants(tags: readonly string[]): number {
  const { cache, unknown, failures, lastKnown } = shared();
  const dropped = cache.invalidate(tags) + unknown.invalidate(tags);
  // An unpublished site is never served again, not even during a later database outage.
  failures.invalidate(tags);
  lastKnown.invalidate(tags);
  log('info', 'sites revalidated', { tags, dropped });
  return dropped;
}

/** The database answers (readiness). */
export async function databaseReady(): Promise<boolean> {
  try {
    await db().execute('select 1');
    return true;
  } catch {
    return false;
  }
}
