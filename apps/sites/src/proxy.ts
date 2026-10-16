import { embedOrigins } from '@bf/site-blocks';
import { type NextRequest, NextResponse } from 'next/server';
import { buildSiteCsp } from './lib/csp.ts';
import { sitesEnvironment } from './lib/env.ts';
import { siteHostname } from './lib/host.ts';
import { getTenant } from './lib/tenant.ts';

/** Where the proxy sends what is not a page of an active site (route handlers that set the status code). */
export const UNKNOWN_PATH = '/-/unknown';
export const GONE_PATH = '/-/gone';

/**
 * Every site request (BF-036): the Host header names a site under SITES_BASE_DOMAIN, or it is a 404; an ended
 * publication is a 410; an active one gets its per-request CSP (nonce, its booking frame only) and, unless the site
 * is a live one that asked to be indexed, `X-Robots-Tag: noindex`.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const env = sitesEnvironment();
  const hostname = siteHostname(request.headers.get('host'), env.SITES_BASE_DOMAIN);
  const tenant = hostname ? await getTenant(hostname) : null;
  const robots = { 'X-Robots-Tag': 'noindex, nofollow' };
  if (!hostname || !tenant) {
    return NextResponse.rewrite(new URL(UNKNOWN_PATH, request.url), { headers: robots });
  }
  if (tenant.status !== 'active' || !tenant.spec) {
    return NextResponse.rewrite(new URL(GONE_PATH, request.url), { headers: robots });
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const https =
    (request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '')) === 'https';
  const csp = buildSiteCsp(nonce, {
    dev: process.env.NODE_ENV === 'development',
    https,
    apiOrigin: new URL(env.API_URL).origin,
    assetsOrigin: new URL(env.SITES_ASSETS_BASE_URL).origin,
    frameOrigins: embedOrigins(tenant.spec),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('x-bf-hostname', hostname);
  requestHeaders.set('x-bf-path', request.nextUrl.pathname);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  if (tenant.noindex) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export const config = {
  // Next's own files, the renderer's status pages and the internal routes (revalidation from the API, health
  // checks: their Host is the internal address) skip it.
  matcher: [{ source: '/((?!_next/static|_next/image|-/|api/revalidate|health/).*)' }],
};
