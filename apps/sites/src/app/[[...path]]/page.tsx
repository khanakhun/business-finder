import { signSiteViewToken } from '@bf/contracts';
import { defaultPageHref, faviconHref, hotlinkSrcSet, pickText, SitePage } from '@bf/site-blocks';

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PreviewActions } from '@/components/preview-actions.tsx';
import { ViewBeacon } from '@/components/view-beacon.tsx';
import { type CurrentSite, currentSite } from '@/lib/current-site.ts';
import { sitesEnvironment } from '@/lib/env.ts';
import { pageAlternates, resolveRoute } from '@/lib/locale-routing.ts';
import { previewActionLinks } from '@/lib/preview-actions.ts';
import { rendererStrings } from '@/lib/strings.ts';

interface Props {
  readonly params: Promise<{ path?: string[] }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function route(
  props: Props,
): Promise<{ site: CurrentSite; route: NonNullable<ReturnType<typeof resolveRoute>> }> {
  const site = await currentSite();
  if (!site) notFound();
  const found = resolveRoute(site.tenant.spec, (await props.params).path ?? []);
  if (!found) notFound();
  return { site, route: found };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { site, route: current } = await route(props);
  const { spec } = site.tenant;
  const text = (value: Parameters<typeof pickText>[0]) => pickText(value, current.locale, spec.defaultLocale);
  const languages = Object.fromEntries(
    Object.entries(pageAlternates(spec, current.page)).map(([locale, path]) => [locale, site.origin + path]),
  );
  return {
    title: text(current.page.seo.title),
    description: text(current.page.seo.description),
    // Previews are never indexed: this tag, X-Robots-Tag (proxy) and robots.txt.
    ...(site.tenant.noindex ? { robots: { index: false, follow: false } } : {}),
    alternates: {
      canonical: site.origin + defaultPageHref(current.page, current.locale, spec),
      ...(spec.locales.length > 1
        ? { languages: { ...languages, 'x-default': languages[spec.defaultLocale] } }
        : {}),
    },
    openGraph: {
      type: 'website',
      title: text(current.page.seo.title),
      description: text(current.page.seo.description),
      siteName: spec.brand.name,
    },
    icons: { icon: faviconHref(spec) },
  };
}

/** A page of the host's site (BF-036), rendered with the block library; previews carry the banner. */
export default async function SitePageRoute(props: Props) {
  const { site, route: current } = await route(props);
  const { tenant } = site;
  const env = sitesEnvironment();
  const token = env.SITES_VIEW_TOKEN_SECRET
    ? await signSiteViewToken(tenant.siteId, env.SITES_VIEW_TOKEN_SECRET)
    : undefined;
  const ref = (await props.searchParams).r;
  const actions =
    tenant.environment === 'preview' && env.SITES_PREVIEW_ACTIONS ? (
      <PreviewActions
        links={previewActionLinks({
          spec: tenant.spec,
          locale: current.locale,
          outreachRef: typeof ref === 'string' ? ref : undefined,
        })}
        strings={rendererStrings(current.locale)}
      />
    ) : undefined;
  return (
    <>
      <SitePage
        spec={tenant.spec}
        page={current.page.id}
        locale={current.locale}
        preview={tenant.environment === 'preview'}
        previewActions={actions}
        agencyName={tenant.agencyName}
        assetsResolver={(asset) => ({
          src: asset.url,
          srcSet: asset.hosting === 'hotlink' ? hotlinkSrcSet(asset.url) : tenant.images[asset.url],
        })}
      />
      {token ? (
        <ViewBeacon
          endpoint={new URL('/v1/public/sites/views', env.API_URL).href}
          token={token}
          pageId={current.page.id}
          locale={current.locale}
        />
      ) : null}
    </>
  );
}
