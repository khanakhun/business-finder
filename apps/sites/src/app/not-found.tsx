import { pickText } from '@bf/site-blocks';
import { currentSite } from '@/lib/current-site.ts';
import { resolveRoute } from '@/lib/locale-routing.ts';
import { rendererStrings } from '@/lib/strings.ts';

/** A page the site does not have: a 404 in the site's language, with the way back home. */
export default async function NotFound() {
  const site = await currentSite();
  const spec = site?.tenant.spec;
  const segments = (site?.path ?? '/').split('/').filter(Boolean);
  const locale = spec ? (resolveRoute(spec, [segments[0] ?? ''])?.locale ?? spec.defaultLocale) : 'en';
  const strings = rendererStrings(locale);
  const home = spec && locale !== spec.defaultLocale ? `/${locale}` : '/';
  return (
    <main className="bf-status">
      {spec ? <p className="bf-status-brand">{spec.brand.name}</p> : null}
      <h1>{strings.notFoundTitle}</h1>
      <p>{strings.notFoundBody}</p>
      <p>
        <a href={home}>
          {spec
            ? `${strings.backHome} — ${pickText(spec.pages[0]?.title, locale, spec.defaultLocale)}`
            : strings.backHome}
        </a>
      </p>
    </main>
  );
}
