import { preferredLocale } from '@/lib/accept-language.ts';
import { sitesEnvironment } from '@/lib/env.ts';
import { siteHostname } from '@/lib/host.ts';
import { statusPage, statusResponse } from '@/lib/status-page.ts';
import { rendererStrings } from '@/lib/strings.ts';
import { getTenant } from '@/lib/tenant.ts';

/**
 * An ended publication (expired or unpublished; the proxy rewrites them here): a real 410 naming the business and the
 * agency, with the agency's link. The host is read from the request, so this page only ever describes its own site.
 */
export async function GET(request: Request): Promise<Response> {
  const lang = preferredLocale(request.headers.get('accept-language'));
  const strings = rendererStrings(lang);
  const hostname = siteHostname(request.headers.get('host'), sitesEnvironment().SITES_BASE_DOMAIN);
  const tenant = hostname ? await getTenant(hostname).catch(() => null) : null;
  const ended = tenant && tenant.status !== 'active';
  const html = ended
    ? statusPage({
        lang,
        title: strings.goneTitle,
        body: strings.goneBody(tenant.businessName, tenant.agencyName),
        link: tenant.agencyUrl
          ? { href: tenant.agencyUrl, label: strings.contactAgency(tenant.agencyName) }
          : undefined,
      })
    : statusPage({ lang, title: strings.unknownTitle, body: strings.unknownBody });
  return statusResponse(html, ended ? 410 : 404);
}
