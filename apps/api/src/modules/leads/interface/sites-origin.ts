/**
 * The origin of a URL when it is one of our sites (`<slug>.<SITES_BASE_DOMAIN>`, https; http too for local domains),
 * else null. Lead forms are only ever posted from there (CORS, and the redirect after a plain form post).
 */
export function siteOrigin(url: string | undefined, baseDomain: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const local = /(^|\.)localhost$|\.test$/.test(baseDomain);
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return null;
    const host = parsed.hostname.toLowerCase();
    return host.endsWith(`.${baseDomain}`) && host.length > baseDomain.length + 1 ? parsed.origin : null;
  } catch {
    return null;
  }
}
