import 'server-only';
import { headers } from 'next/headers';
import { cache } from 'react';
import { sitesEnvironment } from './env.ts';
import { siteHostname } from './host.ts';
import { siteOrigin, siteScheme } from './seo.ts';
import { getTenant, type Tenant } from './tenant.ts';

export interface CurrentSite {
  readonly tenant: Tenant & { readonly spec: NonNullable<Tenant['spec']> };
  readonly origin: string;
  readonly nonce: string | undefined;
  readonly path: string;
}

/**
 * The active site of this request (the proxy let it through: its host names an active publication), or undefined
 * when it ended meanwhile. Once per request (layout, metadata and page share it).
 */
export const currentSite = cache(async (): Promise<CurrentSite | undefined> => {
  const requestHeaders = await headers();
  const env = sitesEnvironment();
  // Always from the Host header (the proxy drops any `x-bf-*` a visitor sends).
  const hostname = siteHostname(requestHeaders.get('host'), env.SITES_BASE_DOMAIN);
  const tenant = hostname ? await getTenant(hostname) : null;
  if (!hostname || tenant?.status !== 'active' || !tenant.spec) return undefined;
  return {
    tenant: tenant as CurrentSite['tenant'],
    origin: siteOrigin({
      hostname,
      scheme: siteScheme(requestHeaders, env.NODE_ENV),
      host: requestHeaders.get('host'),
      production: env.NODE_ENV === 'production',
    }),
    nonce: requestHeaders.get('x-nonce') ?? undefined,
    path: requestHeaders.get('x-bf-path') ?? '/',
  };
});
