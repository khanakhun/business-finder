// Hosts a site may link to (BF-033): its own assets on our storage, the business's own domain, known booking
// providers and the social networks' own hosts. Everything else is an external URL and refused.

/** Online booking providers a business may already use (its booking page may be linked). */
export const KNOWN_BOOKING_HOSTS = [
  'acuityscheduling.com',
  'airbnb.com',
  'booking.com',
  'booksy.com',
  'calendly.com',
  'doctolib.fr',
  'fresha.com',
  'lafourchette.com',
  'opentable.com',
  'opentable.fr',
  'planity.com',
  'resy.com',
  'setmore.com',
  'sevenrooms.com',
  'simplybook.me',
  'thefork.com',
  'thefork.fr',
  'treatwell.co.uk',
  'treatwell.fr',
  'zenchef.com',
] as const;

/**
 * Each network's own hosts (exactly: no other subdomain, where user content or redirects live), and paths that are
 * not profiles (redirect pages, sign-in). A profile URL has no query string.
 */
export const SOCIAL_PROFILES: Readonly<
  Record<string, { readonly hosts: readonly string[]; readonly path?: RegExp }>
> = {
  instagram: { hosts: ['instagram.com', 'www.instagram.com'] },
  facebook: { hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com'] },
  tiktok: { hosts: ['tiktok.com', 'www.tiktok.com'], path: /^\/@[\w.-]+\/?$/ },
  linkedin: { hosts: ['linkedin.com', 'www.linkedin.com'], path: /^\/(company|in)\/[\w-]+\/?$/ },
  youtube: { hosts: ['youtube.com', 'www.youtube.com'], path: /^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w-]+)\/?$/ },
  x: { hosts: ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'], path: /^\/\w{1,15}\/?$/ },
  tripadvisor: {
    hosts: [
      'www.tripadvisor.com',
      'www.tripadvisor.fr',
      'www.tripadvisor.co.uk',
      'www.tripadvisor.de',
      'www.tripadvisor.es',
      'www.tripadvisor.nl',
    ],
    path: /^\/[A-Za-z_]*Review-g\d+-d\d+-[\w%-]+\.html$/,
  },
  google: {
    hosts: ['g.page', 'maps.app.goo.gl', 'www.google.com', 'maps.google.com'],
    path: /^\/(maps\/|[\w-]+\/?$)/,
  },
};

/** Paths of the networks' redirect and utility pages (never a profile). */
const NOT_A_PROFILE = /^\/(l\.php|redirect|redir|url|share|login|sharer)/i;

/** An https URL's host, lowercased; null when it is not https or carries credentials or a port. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The host is one of `allowed` (or a subdomain of one, unless `subdomains` is false). */
export function hostAllowed(url: string, allowed: readonly string[], { subdomains = true } = {}): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return allowed.some((entry) => {
    const domain = entry.toLowerCase();
    return host === domain || (subdomains && host.endsWith(`.${domain}`));
  });
}

/** A URL of the network's own profile pages. */
export function isSocialProfile(network: string, url: string): boolean {
  const profile = SOCIAL_PROFILES[network];
  if (!profile || !hostAllowed(url, profile.hosts, { subdomains: false })) return false;
  const { pathname, search, hash } = new URL(url);
  if (search || hash || NOT_A_PROFILE.test(pathname) || pathname === '/') return false;
  return profile.path ? profile.path.test(pathname) : true;
}

/** A redirect target: a scheme, `//` or `\\`, a backslash, or a web address (control characters dropped first). */
const REDIRECT_TARGET = /^[a-z][\w+.-]*:|^[\\/]{2}|\\|^www\.|^\d{1,3}(?:\.\d{1,3}){3}\b/i;

/** A URL whose query or fragment carries another URL (a redirect: `?u=https://…`, `#next=//…`). Fails closed. */
export function carriesUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    const values = [
      ...parsed.searchParams.values(),
      ...parsed.searchParams.keys(),
      ...fragment.values(),
      ...fragment.keys(),
      decodeURIComponent(parsed.hash.slice(1)),
    ];
    return values.some((raw) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: URL parsers drop these, so they hide a scheme
      const value = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
      return REDIRECT_TARGET.test(value) || hasWebAddress(value);
    });
  } catch {
    // DECISION(BF-033): fail closed. A URL (or a fragment, e.g. `#100%`) that cannot be decoded and inspected is not
    // a safe link, even when it would only be a malformed anchor.
    return true;
  }
}

/** Generic endings a web address in prose is recognised by (two-letter country endings are recognised too). */
const GENERIC_TLDS =
  'com|net|org|info|biz|io|co|app|dev|shop|site|online|store|xyz|me|ly|bar|cafe|club|page|link|live|tech|travel|' +
  'blog|email|world|today|eu|asia|pro|top|vip|art|fun|space|website|restaurant|hotel|immo|paris|bzh|example|test|' +
  // Endings of the local market (villas, boats, beauty, food).
  'villas|villa|luxury|yachts|boats|boutique|beauty|spa|hair|salon|bio|voyage|holiday|rentals|house|homes|estate|' +
  'properties|studio|design|agency|services|menu|pizza|wine|bike|fit|ski|surf|golf|events|photo|tours|beach';
const DOMAIN = new RegExp(
  `(?<![\\p{L}\\p{N}@._-])[\\p{L}\\p{N}-]{2,}(?:\\.[\\p{L}\\p{N}-]+)*\\.(?:[a-z]{2}|${GENERIC_TLDS}|xn--[a-z0-9-]+|[\\p{Script=Cyrillic}\\p{Script=Greek}\\p{Script=Arabic}\\p{Script=Han}\\p{Script=Hangul}]{2,})(?![\\p{L}\\p{N}-])`,
  'iu',
);

const MIDDLE_DOT_DOMAIN = new RegExp(
  `(?<![\\p{L}\\p{N}-])[\\p{L}\\p{N}-]{2,}·(?:${GENERIC_TLDS})(?![\\p{L}\\p{N}-])`,
  'iu',
);

/** A web address in prose: a scheme, `//host`, `www.`, or a domain (look-alike dots and full-width letters folded). */
export function hasWebAddress(text: string): boolean {
  // Look-alike dots read as dots; bullet-like dots as the middle dot (inclusive writing: client•es).
  const folded = text
    .normalize('NFKC')
    .replace(/[。．｡․]/g, '.')
    .replace(/[‧∙⋅•・⸱]/g, '·');
  return (
    /https?:\/\/|(?:^|[\s(])\/\/[\p{L}\p{N}-]+\.|\bwww\./iu.test(folded) ||
    DOMAIN.test(folded) ||
    // A middle dot as the dot only before a generic ending: French inclusive writing (ami·es) is not an address.
    // DECISION(BF-033): `evil·fr` (a two-letter ending) passes: those endings are inclusive writing too (·es, ·te).
    (folded.includes('·') && MIDDLE_DOT_DOMAIN.test(folded))
  );
}
