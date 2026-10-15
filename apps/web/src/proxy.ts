import { type NextRequest, NextResponse } from 'next/server';

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
  options: { dev: boolean; apiOrigin: string; https: boolean },
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${options.apiOrigin}${options.dev ? ' ws:' : ''}`,
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
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV === 'development',
    apiOrigin: new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').origin,
    https: (process.env.NEXT_PUBLIC_APP_URL ?? '').startsWith('https://'),
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
