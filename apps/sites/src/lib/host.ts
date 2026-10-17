/** One DNS label: what a site's slug is under the sites domain. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The site hostname a request is for (`salon-k3x9p2.sites.example`), from its Host header: lowercased, port and
 * trailing dot dropped, exactly one label under the sites domain — or (BF-062) a custom domain outside it. The bare
 * sites domain, a nested name under it and an IP address are not sites.
 */
export function siteHostname(host: string | null | undefined, baseDomain: string): string | undefined {
  const name = hostName(host);
  if (!name) return undefined;
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (name === baseDomain.toLowerCase()) return undefined;
  if (!name.endsWith(suffix)) return customDomain(name) ? name : undefined;
  const label = name.slice(0, -suffix.length);
  return LABEL.test(label) ? name : undefined;
}

/**
 * BF-062: a live site's own domain (`salon.com`, `www.salon.com`): labels of a public name ending in an alphabetic
 * TLD — never an IP address or a single label (the internal names). Only hostnames with a publication resolve.
 */
function customDomain(name: string): boolean {
  const labels = name.split('.');
  return (
    labels.length >= 2 &&
    /^[a-z]{2,63}$/.test(labels.at(-1) ?? '') &&
    labels.every((label) => LABEL.test(label))
  );
}

/** The internal address (the API, the container's health check): a single label or an IP, never a public name. */
export function internalHost(host: string | null | undefined): boolean {
  const name = hostName(host);
  if (!name) return false;
  return !name.includes('.') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) || name.startsWith('[');
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
