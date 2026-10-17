import 'server-only';
import { createDb, type DbClient } from '@bf/db/client';
import { rendererPublishedSites, rendererSiteAssets } from '@bf/db/read-models';
import { migrateSpec, type SiteSpec } from '@bf/site-schema';
import { eq } from 'drizzle-orm';
import { sitesEnvironment } from './env.ts';
import { errorFields, log } from './log.ts';
import {
  createTenantStore,
  type Tenant,
  type TenantStore,
  TenantUnavailableError,
  withDeadline,
} from './tenant-store.ts';

export { type Tenant, TenantUnavailableError } from './tenant-store.ts';

// DECISION(BF-036): one store per process, shared through globalThis by the proxy, pages and route handlers, so the
// revalidation route clears what the proxy and the pages read (the e2e "410 after revalidation" test guards it).
// Next documents Proxy as possibly isolated; this holds for self-hosted `next start` / standalone (one process).
// With several replicas, revalidation reaches one: run one replica, or fan revalidation out (follow-up).
const SHARED = Symbol.for('bf.sites.tenants');
interface Shared {
  db?: DbClient;
  store?: TenantStore;
}
const shared = (): Shared => {
  const holder = globalThis as unknown as Record<symbol, Shared | undefined>;
  holder[SHARED] ??= {};
  return holder[SHARED];
};

/** The renderer's read-only database (shared by tenants and the live legal pages, BF-062). */
export function rendererDb(): DbClient {
  return db();
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

async function loadTenant(hostname: string): Promise<Tenant | null> {
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
    redirectTo: row.redirectTo,
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

function store(): TenantStore {
  const state = shared();
  state.store ??= createTenantStore((hostname) => withDeadline(loadTenant(hostname)));
  return state.store;
}

/** The tenant of a site hostname; throws `TenantUnavailableError` when it cannot be known now (503). */
export const getTenant = (hostname: string): Promise<Tenant | null> => store().get(hostname);

/** Drops the cached tenants carrying one of the tags (the API's revalidation). */
export const invalidateTenants = (tags: readonly string[]): number => store().invalidate(tags);

/** The database answers (readiness), within the lookup deadline. */
export async function databaseReady(): Promise<boolean> {
  try {
    await withDeadline(db().execute('select 1'));
    return true;
  } catch {
    return false;
  }
}
