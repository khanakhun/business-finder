import { embedOrigins } from '@bf/site-blocks';
import { type NextRequest, NextResponse } from 'next/server';
import { buildSiteCsp } from './lib/csp.ts';
import { sitesEnvironment } from './lib/env.ts';
import { siteHostname } from './lib/host.ts';
import { localeOfPath, resolveRoute } from './lib/locale-routing.ts';
import { siteScheme } from './lib/seo.ts';
import { getTenant, type Tenant, TenantUnavailableError } from './lib/tenant.ts';

/** Where the proxy sends what is not a page of an active site (route handlers that set the status code). */
export const UNKNOWN_PATH = '/-/unknown';
export const GONE_PATH = '/-/gone';
export const NOT_FOUND_PATH = '/-/not-found';
export const UNAVAILABLE_PATH = '/-/unavailable';
/** A site's own files besides its pages. */
const SITE_FILES = new Set(['/robots.txt', '/sitemap.xml']);

/**
 * Every site request (BF-036): the Host header names a site under SITES_BASE_DOMAIN, or it is a 404; an ended
 * publication is a 410; a path that is not one of its pages is a 404 in its language (a real status, a readable page
 * without JavaScript); an active page gets its per-request CSP (nonce, its booking frame only) and, unless the site is
 * a live one that asked to be indexed, `X-Robots-Tag: noindex`.
 */
/** The internal routes (the API's revalidation, the container's health checks): exact paths only. */
const INTERNAL = new Set(['/api/revalidate', '/health/live', '/health/ready']);
/** Headers only the proxy may set: a visitor's own values are always dropped. */
const PROXY_HEADERS = ['x-nonce', 'content-security-policy'];

function cleanHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  for (const name of PROXY_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()]) if (name.startsWith('x-bf-')) headers.delete(name);
  return headers;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const requestHeaders = cleanHeaders(request);
  const { pathname } = request.nextUrl;
  if (INTERNAL.has(pathname)) return NextResponse.next({ request: { headers: requestHeaders } });
  const env = sitesEnvironment();
  const robots = { 'X-Robots-Tag': 'noindex, nofollow' };
  const rewrite = (path: string, extra: Record<string, string> = {}) => {
    for (const [name, value] of Object.entries(extra)) requestHeaders.set(name, value);
    return NextResponse.rewrite(new URL(path, request.url), {
      headers: robots,
      request: { headers: requestHeaders },
    });
  };
  const hostname = siteHostname(request.headers.get('host'), env.SITES_BASE_DOMAIN);
  let tenant: Tenant | null;
  try {
    tenant = hostname ? await getTenant(hostname) : null;
  } catch (error) {
    if (error instanceof TenantUnavailableError) return rewrite(UNAVAILABLE_PATH);
    throw error;
  }
  if (!hostname || !tenant) return rewrite(UNKNOWN_PATH);
  if (tenant.status !== 'active' || !tenant.spec) return rewrite(GONE_PATH);
  const spec = tenant.spec;
  if (!SITE_FILES.has(pathname)) {
    const segments = pathname.split('/').filter(Boolean);
    // The default language has no prefix: `/fr/carte` on a French site is `/carte`.
    if (segments[0] === spec.defaultLocale) {
      const target = new URL(`/${segments.slice(1).join('/')}`, request.url);
      target.search = request.nextUrl.search;
      return NextResponse.redirect(target, 308);
    }
    if (!resolveRoute(spec, segments.map(safeDecode))) {
      return rewrite(NOT_FOUND_PATH, { 'x-bf-locale': localeOfPath(spec, segments) });
    }
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildSiteCsp(nonce, {
    dev: env.NODE_ENV === 'development',
    https: siteScheme(request.headers, env.NODE_ENV) === 'https',
    apiOrigin: new URL(env.API_URL).origin,
    assetsOrigin: new URL(env.SITES_ASSETS_BASE_URL).origin,
    frameOrigins: embedOrigins(spec),
  });
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('x-bf-path', pathname);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  if (tenant.noindex) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export const config = {
  // Every path but Next's built files: the proxy itself lets the exact internal routes through (their Host is the
  // internal address), so a look-alike path (`/api/revalidatex`, `/-/x`) is a site path like any other.
  matcher: [{ source: '/((?!_next/static|_next/image).*)' }],
};
