import { currentSite } from '@/lib/current-site.ts';
import { sitemapXml } from '@/lib/seo.ts';

/** Per-site sitemap, for live sites that ask to be indexed only (a preview has none). */
export async function GET(): Promise<Response> {
  const site = await currentSite();
  if (site?.tenant.environment !== 'live' || site.tenant.noindex)
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  return new Response(sitemapXml(site.tenant.spec, site.origin), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
