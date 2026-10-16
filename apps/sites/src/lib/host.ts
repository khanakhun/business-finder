/** One DNS label: what a site's slug is under the sites domain. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The site hostname a request is for (`salon-k3x9p2.sites.example`), from its Host header: lowercased, port and
 * trailing dot dropped, exactly one label under the sites domain. Anything else (another domain, the bare domain, a
 * nested name, an IP address) is not a site.
 */
export function siteHostname(host: string | null | undefined, baseDomain: string): string | undefined {
  if (!host) return undefined;
  const name = host
    .trim()
    .toLowerCase()
    .replace(/:\d{1,5}$/, '')
    .replace(/\.$/, '');
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return undefined;
  const label = name.slice(0, -suffix.length);
  return LABEL.test(label) ? name : undefined;
}
