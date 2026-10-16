import { currentSite } from '@/lib/current-site.ts';
import { robotsTxt } from '@/lib/seo.ts';

/** Per-site robots.txt: previews are closed to every crawler but our screenshot bot. */
export async function GET(): Promise<Response> {
  const site = await currentSite();
  const indexable = Boolean(site && site.tenant.environment === 'live' && !site.tenant.noindex);
  return new Response(robotsTxt({ indexable, origin: site?.origin ?? '' }), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
