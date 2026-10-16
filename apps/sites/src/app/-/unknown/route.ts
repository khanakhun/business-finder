import { preferredLocale } from '@/lib/accept-language.ts';
import { statusPage, statusResponse } from '@/lib/status-page.ts';
import { rendererStrings } from '@/lib/strings.ts';

/** No site at this address (the proxy rewrites unknown hosts here): a real 404. */
export function GET(request: Request): Response {
  const lang = preferredLocale(request.headers.get('accept-language'));
  const strings = rendererStrings(lang);
  return statusResponse(statusPage({ lang, title: strings.unknownTitle, body: strings.unknownBody }), 404);
}
