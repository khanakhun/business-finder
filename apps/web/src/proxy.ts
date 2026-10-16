import { type NextRequest, NextResponse } from 'next/server';
import { serverPublicEnv } from './lib/public-env.ts';

/**
 * Per-request Content-Security-Policy (security.md §8: nonce-based for scripts). Next.js reads the nonce from the
 * request's CSP header and applies it to its own scripts; next-themes receives it through the layout.
 *
 * DECISION(BF-007): styles allow 'unsafe-inline'. UI libraries inject <style> elements at runtime (sonner's CSS) and
 * Radix positions popovers with style attributes; neither can carry our nonce, and the e2e CSP check showed both
 * blocked. Styles cannot execute code; scripts stay nonce + 'strict-dynamic' only.
 */
export function buildCsp(
  nonce: string,
  options: {
    dev: boolean;
    apiOrigin: string;
    https: boolean;
    mapOrigin?: string;
    sitesAssetsOrigin?: string;
    /** Object storage, for the site editor's presigned image uploads (BF-037). */
    uploadsOrigin?: string;
  },
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // The search map (BF-023) loads its style, tiles, glyphs and sprites from the map origin; MapLibre's workers
    // are blob: URLs.
    // The site editor's canvas (BF-037) shows the sites' images from their CDN.
    `img-src 'self' blob: data:${options.mapOrigin ? ` ${options.mapOrigin}` : ''}${options.sitesAssetsOrigin ? ` ${options.sitesAssetsOrigin}` : ''}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self' ${options.apiOrigin}${options.mapOrigin ? ` ${options.mapOrigin}` : ''}${options.uploadsOrigin ? ` ${options.uploadsOrigin}` : ''}${options.dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only over HTTPS: on a local http production build it would rewrite API calls to https:// and break them.
    ...(options.https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const env = serverPublicEnv();
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV === 'development',
    apiOrigin: new URL(env.apiUrl).origin,
    https: env.appUrl.startsWith('https://'),
    mapOrigin: new URL(env.mapStyleUrl).origin,
    sitesAssetsOrigin: new URL(env.sitesAssetsUrl).origin,
    ...(env.sitesUploadsUrl ? { uploadsOrigin: new URL(env.sitesUploadsUrl).origin } : {}),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // The dashboard layout needs the requested path to send signed-out visitors back after sign-in.
  requestHeaders.set('x-pathname', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Static assets and Next internals do not need a per-request policy.
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
};
