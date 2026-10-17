import { embedOrigins, hotlinkOrigins } from '@bf/site-blocks';
import { type NextRequest, NextResponse } from 'next/server';
import { buildSiteCsp } from './lib/csp.ts';
import { sitesEnvironment } from './lib/env.ts';
import { internalHost, siteHostname, underSitesDomain } from './lib/host.ts';
import { leadPageOf } from './lib/lead-pages.ts';
import { livePageOf } from './lib/live-paths.ts';
import { localeOfPath, resolveRoute } from './lib/locale-routing.ts';
import { cleanHeaders } from './lib/proxy-headers.ts';
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
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const requestHeaders = cleanHeaders(request.headers);
  const { pathname } = request.nextUrl;
  const env = sitesEnvironment();
  const hostname = siteHostname(request.headers.get('host'), env.SITES_BASE_DOMAIN);
  // The internal routes answer only on the internal address (the API, the container's health check): under the sites
  // domain (any name, a valid site label or not) they are site paths like any other, whatever proxy sits in front.
  // BF-062: custom domains are public names outside the sites domain: only the internal address reaches these routes.
  if (
    INTERNAL.has(pathname) &&
    !underSitesDomain(request.headers.get('host'), env.SITES_BASE_DOMAIN) &&
    internalHost(request.headers.get('host'))
  )
    return NextResponse.next({ request: { headers: requestHeaders } });
  const robots = { 'X-Robots-Tag': 'noindex, nofollow' };
  const rewrite = (path: string, extra: Record<string, string> = {}) => {
    for (const [name, value] of Object.entries(extra)) requestHeaders.set(name, value);
    return NextResponse.rewrite(new URL(path, request.url), {
      headers: robots,
      request: { headers: requestHeaders },
    });
  };
  let tenant: Tenant | null;
  try {
    tenant = hostname ? await getTenant(hostname) : null;
  } catch (error) {
    if (error instanceof TenantUnavailableError) return rewrite(UNAVAILABLE_PATH);
    throw error;
  }
  if (!hostname || !tenant) return rewrite(UNKNOWN_PATH);
  // BF-062: a `www` name to its apex, the site's own hostname to its custom domain (permanent).
  if (tenant.redirectTo && tenant.redirectTo !== hostname) {
    const target = new URL(`${pathname}${request.nextUrl.search}`, `https://${tenant.redirectTo}`);
    return NextResponse.redirect(target, 301);
  }
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
    const decoded = segments.map(safeDecode);
    // A preview's lead pages (BF-048) are the renderer's own: /claim, /opt-out, /privacy in each language.
    const leadPage =
      tenant.environment === 'preview' && env.SITES_PREVIEW_ACTIONS && leadPageOf(spec, decoded);
    // BF-062: a live site's legal pages (/legal, /privacy in each language).
    const livePage = tenant.environment === 'live' && livePageOf(spec, decoded);
    if (!leadPage && !livePage && !resolveRoute(spec, decoded)) {
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
    imageOrigins: hotlinkOrigins(spec),
  });
  requestHeaders.set('x-nonce', nonce);
  // The decoded path (the route was resolved from decoded segments: `/%65n/x` is `/en/x`).
  requestHeaders.set('x-bf-path', `/${pathname.split('/').filter(Boolean).map(safeDecode).join('/')}`);
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
  // Every path but Next's built files (`_next/static/` with its slash: `/_next/staticx` is a site path; the renderer
  // uses no `next/image`) and the block library's stylesheet and fonts (public/_bf): the proxy itself lets the exact
  // internal routes through on the internal address only, so a look-alike path (`/api/revalidatex`, `/-/x`) is a site
  // path like any other.
  matcher: [{ source: '/((?!_next/static/|_bf/).*)' }],
};
