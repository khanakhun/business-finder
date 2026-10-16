import 'server-only';
import { headers } from 'next/headers';
import { sitesEnvironment } from './env.ts';
import { siteHostname } from './host.ts';
import { requestOrigin } from './seo.ts';
import { getTenant, type Tenant } from './tenant.ts';

export interface CurrentSite {
  readonly tenant: Tenant & { readonly spec: NonNullable<Tenant['spec']> };
  readonly origin: string;
  readonly nonce: string | undefined;
  readonly path: string;
}

/**
 * The active site of this request (the proxy let it through: its host names an active publication), or undefined
 * when it ended meanwhile.
 */
export async function currentSite(): Promise<CurrentSite | undefined> {
  const requestHeaders = await headers();
  const hostname =
    requestHeaders.get('x-bf-hostname') ??
    siteHostname(requestHeaders.get('host'), sitesEnvironment().SITES_BASE_DOMAIN);
  const tenant = hostname ? await getTenant(hostname) : null;
  if (tenant?.status !== 'active' || !tenant.spec) return undefined;
  return {
    tenant: tenant as CurrentSite['tenant'],
    origin: requestOrigin(requestHeaders, 'http:'),
    nonce: requestHeaders.get('x-nonce') ?? undefined,
    path: requestHeaders.get('x-bf-path') ?? '/',
  };
}
