import { pickText } from '@bf/site-blocks';
import { sitesEnvironment } from '@/lib/env.ts';
import { siteHostname } from '@/lib/host.ts';
import { statusPage, statusResponse } from '@/lib/status-page.ts';
import { rendererStrings } from '@/lib/strings.ts';
import { getTenant } from '@/lib/tenant.ts';

/** A path that is not a page of the site (the proxy rewrites it here): a real 404 in its language, with home. */
export async function GET(request: Request): Promise<Response> {
  const hostname = siteHostname(request.headers.get('host'), sitesEnvironment().SITES_BASE_DOMAIN);
  const tenant = hostname ? await getTenant(hostname).catch(() => null) : null;
  const spec = tenant?.status === 'active' ? tenant.spec : null;
  const requested = request.headers.get('x-bf-locale') ?? '';
  const lang = spec?.locales.find((locale) => locale === requested) ?? spec?.defaultLocale ?? 'en';
  const strings = rendererStrings(lang);
  const home = spec && lang !== spec.defaultLocale ? `/${lang}` : '/';
  const homeTitle = spec
    ? pickText(spec.pages.find((page) => page.slug === '')?.title, lang, spec.defaultLocale)
    : '';
  return statusResponse(
    statusPage({
      lang,
      title: strings.notFoundTitle,
      body: strings.notFoundBody,
      link: { href: home, label: homeTitle ? `${strings.backHome} — ${homeTitle}` : strings.backHome },
    }),
    404,
  );
}
