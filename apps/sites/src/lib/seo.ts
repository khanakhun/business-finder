import { defaultPageHref } from '@bf/site-blocks';
import type { SiteSpec } from '@bf/site-schema';

/** Our screenshot bot (services/intel, `SITE_INTEL_USER_AGENT`): it pictures previews for the dashboard. */
export const PREVIEW_BOT = 'BusinessFinderBot';

/** The scheme visitors use: https in production (behind the proxy), else as the request arrived. */
export function siteScheme(headers: Headers, nodeEnv: string): 'https' | 'http' {
  if (nodeEnv === 'production') return 'https';
  return headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https' ? 'https' : 'http';
}

/**
 * A site's origin for canonical and alternate links, from its normalised hostname (never the raw Host header):
 * the port only outside production (`http://salon.sites.localhost:3110` locally).
 */
export function siteOrigin(input: {
  readonly hostname: string;
  readonly scheme: 'https' | 'http';
  readonly host: string | null;
  readonly production: boolean;
}): string {
  const port = input.production ? undefined : /:(\d{1,5})$/.exec(input.host ?? '')?.[1];
  return `${input.scheme}://${input.hostname}${port ? `:${port}` : ''}`;
}

/**
 * robots.txt: a preview (or any site not asking to be indexed) disallows everything but our screenshot bot; a live,
 * indexable site allows everything and names its sitemap.
 */
export function robotsTxt(input: { readonly indexable: boolean; readonly origin: string }): string {
  if (!input.indexable)
    return [`User-agent: ${PREVIEW_BOT}`, 'Allow: /', '', 'User-agent: *', 'Disallow: /', ''].join('\n');
  return ['User-agent: *', 'Allow: /', '', `Sitemap: ${input.origin}/sitemap.xml`, ''].join('\n');
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** sitemap.xml: every page in every language, with its language alternates. */
export function sitemapXml(spec: SiteSpec, origin: string): string {
  const urls = spec.pages.flatMap((page) =>
    spec.locales.map((locale) => {
      const alternates = spec.locales
        .map(
          (other) =>
            `<xhtml:link rel="alternate" hreflang="${other}" href="${xml(origin + defaultPageHref(page, other, spec))}"/>`,
        )
        .join('');
      return `<url><loc>${xml(origin + defaultPageHref(page, locale, spec))}</loc>${alternates}</url>`;
    }),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}
