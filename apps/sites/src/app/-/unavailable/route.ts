import { preferredLocale } from '@/lib/accept-language.ts';
import { statusPage, statusResponse } from '@/lib/status-page.ts';
import { rendererStrings } from '@/lib/strings.ts';

/** The site cannot be known now (database unreachable, a spec newer than this renderer): a 503 to retry. */
export function GET(request: Request): Response {
  const lang = preferredLocale(request.headers.get('accept-language'));
  const strings = rendererStrings(lang);
  return statusResponse(
    statusPage({ lang, title: strings.unavailableTitle, body: strings.unavailableBody }),
    503,
    {
      'Retry-After': '60',
    },
  );
}
