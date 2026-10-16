import 'server-only';
import { createDb, type DbClient } from '@bf/db/client';
import { rendererPublishedSites, rendererSiteAssets } from '@bf/db/read-models';
import { migrateSpec, type SiteSpec } from '@bf/site-schema';
import { eq } from 'drizzle-orm';
import { sitesEnvironment } from './env.ts';
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

/** How long a lookup is reused without a revalidation (a preview is never served past its expiry). */
const TENANT_TTL_MS = 60_000;
/** An unknown host is looked up again soon (publishing it revalidates `host:<name>` anyway). */
const UNKNOWN_TTL_MS = 10_000;

interface Shared {
  db?: DbClient;
  cache: TagCache<Tenant | null>;
}

// One cache and one pool per process, whatever bundle (proxy, pages, route handlers) asks: the revalidation route
// clears what the proxy and the pages read.
const SHARED = Symbol.for('bf.sites.tenants');
function shared(): Shared {
  const holder = globalThis as unknown as Record<symbol, Shared | undefined>;
  holder[SHARED] ??= { cache: new TagCache<Tenant | null>(2_000) };
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
    // Stored versions were validated when saved; an older schema version is upcast.
    spec: active ? migrateSpec(row.spec) : null,
    images,
  };
}

/** The tenant of a site hostname (cache-aside, tagged `host:<hostname>` and `site:<id>`). */
export async function getTenant(hostname: string): Promise<Tenant | null> {
  const { cache } = shared();
  const now = Date.now();
  const hit = cache.get(hostname, now);
  if (hit !== undefined) return hit;
  const tenant = await load(hostname);
  const expiry =
    tenant?.status === 'active' && tenant.expiresAt ? Date.parse(tenant.expiresAt) : Number.POSITIVE_INFINITY;
  const until = Math.min(now + (tenant ? TENANT_TTL_MS : UNKNOWN_TTL_MS), expiry);
  cache.set(
    hostname,
    tenant,
    until,
    tenant ? [`host:${hostname}`, `site:${tenant.siteId}`] : [`host:${hostname}`],
  );
  return tenant;
}

/** Drops the cached tenants carrying one of the tags (the API's revalidation). */
export function invalidateTenants(tags: readonly string[]): number {
  return shared().cache.invalidate(tags);
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
