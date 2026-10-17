import { signSiteViewToken } from '@bf/contracts';
import { defaultPageHref, faviconHref, hotlinkSrcSet, pickText, SitePage } from '@bf/site-blocks';

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { LeadPageView } from '@/components/lead-pages.tsx';
import { LegalLinks, LegalPageView } from '@/components/legal-pages.tsx';
import { PreviewActions } from '@/components/preview-actions.tsx';
import { ViewBeacon } from '@/components/view-beacon.tsx';
import { type CurrentSite, currentSite } from '@/lib/current-site.ts';
import { sitesEnvironment } from '@/lib/env.ts';
import { jsonLdText, localBusinessJsonLd } from '@/lib/jsonld.ts';
import { type LeadPage, leadFormFields, leadPageOf } from '@/lib/lead-pages.ts';
import { leadStrings } from '@/lib/lead-strings.ts';
import { legalStrings } from '@/lib/legal-locale.ts';
import { livePageOf, siteLegal } from '@/lib/live-pages.ts';
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

/** A preview's lead page (`/claim`, `/opt-out`, `/privacy`, BF-048), when the path names one and previews take leads. */
async function leadRoute(props: Props) {
  const site = await currentSite();
  if (!site || site.tenant.environment !== 'preview' || !sitesEnvironment().SITES_PREVIEW_ACTIONS)
    return null;
  const segments = (await props.params).path ?? [];
  if (resolveRoute(site.tenant.spec, segments)) return null;
  const lead = leadPageOf(site.tenant.spec, segments);
  return lead ? { site, ...lead } : null;
}

/** A live site's legal pages (`/legal`, `/privacy`, BF-062), when the path names one. */
async function liveRoute(props: Props) {
  const site = await currentSite();
  if (!site || site.tenant.environment !== 'live') return null;
  const segments = (await props.params).path ?? [];
  if (resolveRoute(site.tenant.spec, segments)) return null;
  const live = livePageOf(site.tenant.spec, segments);
  return live ? { site, ...live } : null;
}

const LEAD_TITLES: Record<
  LeadPage,
  (s: ReturnType<typeof leadStrings>, business: string, agency: string) => string
> = {
  claim: (s, business) => s.claimTitle(business),
  'opt-out': (s) => s.optOutTitle,
  privacy: (s, _business, agency) => s.privacyTitle(agency),
};

export async function generateMetadata(props: Props): Promise<Metadata> {
  const live = await liveRoute(props);
  if (live) {
    const strings = legalStrings(live.locale);
    return {
      title: `${live.page === 'legal' ? strings.legalTitle : strings.privacyTitle} – ${live.site.tenant.businessName}`,
    };
  }
  const lead = await leadRoute(props);
  if (lead)
    return {
      title: LEAD_TITLES[lead.page](
        leadStrings(lead.locale),
        lead.site.tenant.businessName,
        lead.site.tenant.agencyName,
      ),
      robots: { index: false, follow: false },
    };
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
  const lead = await leadRoute(props);
  if (lead) return <LeadPageRoute {...props} lead={lead} />;
  const live = await liveRoute(props);
  if (live) {
    const prefix = live.locale === live.site.tenant.spec.defaultLocale ? '' : `/${live.locale}`;
    return (
      <LegalPageView
        page={live.page}
        legal={await siteLegal(live.site.tenant.siteId)}
        business={live.site.tenant.businessName}
        strings={legalStrings(live.locale)}
        homeHref={prefix || '/'}
        locale={live.locale}
      />
    );
  }
  const { site, route: current } = await route(props);
  const { tenant } = site;
  const env = sitesEnvironment();
  const token = env.SITES_VIEW_TOKEN_SECRET
    ? await signSiteViewToken(tenant.siteId, env.SITES_VIEW_TOKEN_SECRET)
    : undefined;
  const query = await props.searchParams;
  const ref = query.r;
  // A preview's contact form goes to the agency (BF-048), under a notice saying so.
  const previewLeadForm =
    tenant.environment === 'preview' && env.SITES_PREVIEW_ACTIONS && token && env.SITES_VIEW_TOKEN_SECRET
      ? {
          action: new URL('/v1/public/sites/leads', env.API_URL).href,
          hidden: await leadFormFields({
            siteToken: token,
            siteId: tenant.siteId,
            secret: env.SITES_VIEW_TOKEN_SECRET,
            kind: 'contact_request',
            source: 'contact_block',
            locale: current.locale,
            next: site.path,
            campaign: typeof query.c === 'string' ? query.c : undefined,
            outreachRef: typeof ref === 'string' ? ref : undefined,
          }),
          notice: leadStrings(current.locale).contactNotice(tenant.agencyName, tenant.businessName),
        }
      : undefined;
  // BF-062: a live site's contact form goes to the business (its confirmed address), under a notice saying so.
  const liveLeadForm =
    tenant.environment === 'live' &&
    tenant.spec.settings.contactForm.enabled &&
    token &&
    env.SITES_VIEW_TOKEN_SECRET
      ? {
          action: new URL('/v1/public/sites/leads', env.API_URL).href,
          hidden: await leadFormFields({
            siteToken: token,
            siteId: tenant.siteId,
            secret: env.SITES_VIEW_TOKEN_SECRET,
            kind: 'contact_request',
            source: 'live_site',
            locale: current.locale,
            next: site.path,
          }),
          notice: legalStrings(current.locale).formNotice(tenant.businessName),
        }
      : undefined;
  const leadForm = previewLeadForm ?? liveLeadForm;
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const prefix = current.locale === tenant.spec.defaultLocale ? '' : `/${current.locale}`;
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
        {...(leadForm ? { previewLeadForm: leadForm } : {})}
        assetsResolver={(asset) => ({
          src: asset.url,
          srcSet: asset.hosting === 'hotlink' ? hotlinkSrcSet(asset.url) : tenant.images[asset.url],
        })}
      />
      {tenant.environment === 'live' ? (
        <>
          <LegalLinks prefix={prefix} strings={legalStrings(current.locale)} />
          <script
            type="application/ld+json"
            nonce={nonce}
            // JSON-LD from the validated spec only, `<` escaped (no early `</script>`).
            dangerouslySetInnerHTML={{ __html: jsonLdText(localBusinessJsonLd(tenant.spec, site.origin)) }}
          />
        </>
      ) : null}
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

/** A lead page of a preview (BF-048): its form carries signed tokens and the way back after a plain post. */
async function LeadPageRoute(props: Props & { lead: NonNullable<Awaited<ReturnType<typeof leadRoute>>> }) {
  const { site, page, locale } = props.lead;
  const { tenant } = site;
  const env = sitesEnvironment();
  const query = await props.searchParams;
  const secret = env.SITES_VIEW_TOKEN_SECRET;
  const token = secret ? await signSiteViewToken(tenant.siteId, secret) : undefined;
  const prefix = locale === tenant.spec.defaultLocale ? '' : `/${locale}`;
  const endpoints =
    token && page !== 'privacy'
      ? {
          submit: new URL('/v1/public/sites/leads', env.API_URL).href,
          challenge: `${new URL('/v1/public/sites/altcha-challenge', env.API_URL).href}?${new URLSearchParams({ siteToken: token })}`,
        }
      : null;
  const hidden =
    token && secret && page !== 'privacy'
      ? await leadFormFields({
          siteToken: token,
          siteId: tenant.siteId,
          secret,
          kind: page === 'claim' ? 'claim_interest' : 'opt_out',
          source: page === 'claim' ? 'claim_page' : 'opt_out_link',
          locale,
          next: `${prefix}/${page}`,
          campaign: typeof query.c === 'string' ? query.c : undefined,
          outreachRef: typeof query.r === 'string' ? query.r : undefined,
        })
      : {};
  return (
    <LeadPageView
      page={page}
      locale={locale}
      strings={leadStrings(locale)}
      business={tenant.businessName}
      agency={tenant.agencyName}
      agencyUrl={tenant.agencyUrl}
      endpoints={endpoints}
      hidden={hidden}
      sent={typeof query.sent === 'string' ? query.sent : undefined}
      homeHref={prefix || '/'}
      privacyHref={`${prefix}/privacy`}
    />
  );
}
