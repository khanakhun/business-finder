// Where sites are hosted (BF-036): previews must never share the dashboard's cookies.

const normal = (domain: string) =>
  domain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');

/**
 * Whether the sites domain sits under the auth cookie domain (or is it): every preview host would then receive staff
 * sessions and count as same-site with the API. Compared case-insensitively, leading and trailing dots ignored.
 */
export function sitesShareCookieDomain(sitesDomain: string, cookieDomain: string | undefined): boolean {
  if (!cookieDomain) return false;
  const [sites, cookie] = [normal(sitesDomain), normal(cookieDomain)];
  return cookie !== '' && (sites === cookie || sites.endsWith(`.${cookie}`));
}
