import { preferredLocale } from '@/lib/accept-language.ts';
import { STATUS_PAGE_CSP, statusPage } from '@/lib/status-page.ts';
import { rendererStrings } from '@/lib/strings.ts';

/** No site at this address (the proxy rewrites unknown hosts here): a real 404. */
export function GET(request: Request): Response {
  const lang = preferredLocale(request.headers.get('accept-language'));
  const strings = rendererStrings(lang);
  return new Response(statusPage({ lang, title: strings.unknownTitle, body: strings.unknownBody }), {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': STATUS_PAGE_CSP,
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
  });
}
