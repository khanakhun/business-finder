/** One DNS label: what a site's slug is under the sites domain. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The site hostname a request is for (`salon-k3x9p2.sites.example`), from its Host header: lowercased, port and
 * trailing dot dropped, exactly one label under the sites domain. Anything else (another domain, the bare domain, a
 * nested name, an IP address) is not a site.
 */
export function siteHostname(host: string | null | undefined, baseDomain: string): string | undefined {
  const name = hostName(host);
  if (!name) return undefined;
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return undefined;
  const label = name.slice(0, -suffix.length);
  return LABEL.test(label) ? name : undefined;
}

/** The sites domain or any name under it, valid site label or not (`a_b.sites.example`, `a.b.sites.example`). */
export function underSitesDomain(host: string | null | undefined, baseDomain: string): boolean {
  const name = hostName(host);
  const base = baseDomain.toLowerCase();
  return name !== undefined && (name === base || name.endsWith(`.${base}`));
}

/** A Host header's name: lowercased, port and trailing dot dropped. */
function hostName(host: string | null | undefined): string | undefined {
  if (!host) return undefined;
  return host
    .trim()
    .toLowerCase()
    .replace(/:\d{1,5}$/, '')
    .replace(/\.$/, '');
}
