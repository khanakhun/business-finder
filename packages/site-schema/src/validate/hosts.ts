import { parse } from 'tldts';

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
/** Country endings that sell one-letter names (`x.cc`, `t.co`), and the endings link shorteners use. */
const SHORT_NAME_TLDS =
  'cc|gg|am|to|tv|ai|ws|fm|la|sh|gd|nu|mp|ly|me|io|co|de|fr|uk|us|eu|so|im|is|it|be|nl|es';

const GENERIC = new Set(GENERIC_TLDS.split('|'));
const SHORT_NAMES = new Set(SHORT_NAME_TLDS.split('|'));
const known = new Map<string, boolean>();
/** A real top-level domain (the public suffix list, ICANN section), cached. */
function isTld(label: string): boolean {
  let answer = known.get(label);
  if (answer === undefined) {
    const parsed = parse(`x.${label}`, { allowPrivateDomains: false });
    answer = parsed.isIcann === true && parsed.publicSuffix === label;
    if (known.size < 10_000) known.set(label, answer);
  }
  return answer;
}

/** An ending a web address is recognised by: any two letters, a listed ending, punycode, or a real TLD. */
const isEnding = (label: string) =>
  /^[a-z]{2}$/.test(label) ||
  GENERIC.has(label) ||
  /^xn--[a-z0-9-]{1,59}$/.test(label) ||
  (/\p{L}{2}/u.test(label) && isTld(label));

/**
 * A domain in a token of letters, digits, dots and dashes: a name of two or more characters (or any label after
 * another, `m.evil.com`) before an ending (`evil.com`, `evil.ovh`, `Gustavia.Le`); a one-character name before a
 * generic or short-name ending (`x.com`, `t.me`, `x.cc`), or before any letters when a path follows (`j.mp/promo`).
 * Abbreviations (`p.ex.`, `S.A.R.L.`, `M.Dupont`) stay text. Tokens are cut on everything else (`x_evil.com`,
 * `*.evil.com`), one pass over the text: linear.
 */
function hasDomain(text: string): boolean {
  for (const match of text.matchAll(/[\p{L}\p{N}.-]+/gu)) {
    const token = match[0].toLowerCase();
    const at = match.index ?? 0;
    // An e-mail's domain is the facts validator's (its `@` is just before).
    if (text[at - 1] === '@') continue;
    const labels = token.split('.');
    if (labels.length < 2) continue;
    let named = false;
    for (const [i, label] of labels.entries()) {
      if (label === '') {
        named = false;
        continue;
      }
      if (i > 0 && labels[i - 1] !== '') {
        const previous = labels[i - 1] as string;
        if ((named || previous.length >= 2) && isEnding(label)) return true;
        if (previous.length === 1 && !named) {
          if (GENERIC.has(label) || SHORT_NAMES.has(label)) return true;
          const after = text[at + token.length];
          if (after === '/' && i === labels.length - 1 && /^[a-z]{2,63}$/.test(label)) return true;
        }
      }
      if (label.length >= 2) named = true;
    }
  }
  return false;
}

const MIDDLE_DOT_DOMAIN = new RegExp(
  `(?<![\\p{L}\\p{N}-])[\\p{L}\\p{N}-]{2,63}·(?:${GENERIC_TLDS})(?![\\p{L}\\p{N}-])`,
  'iu',
);

/** A web address in prose: a scheme, `//host`, `www.`, or a domain (look-alike dots and full-width letters folded). */
export function hasWebAddress(text: string): boolean {
  // Look-alike dots read as dots; bullet-like dots as the middle dot (inclusive writing: client•es).
  // Combining marks dropped first: `evil.\u034Fcom` and `évil.com` read as `evil.com`.
  const folded = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .normalize('NFKC')
    .replace(/[。．｡․]/g, '.')
    .replace(/[‧∙⋅•・⸱]/g, '·');
  return (
    /https?:\/\/|(?:^|[\s(])\/\/[\p{L}\p{N}-]+\.|\bwww\./iu.test(folded) ||
    hasDomain(folded) ||
    // A middle dot as the dot only before a generic ending: French inclusive writing (ami·es) is not an address.
    // DECISION(BF-033): `evil·fr` (a two-letter ending) passes: those endings are inclusive writing too (·es, ·te).
    (folded.includes('·') && MIDDLE_DOT_DOMAIN.test(folded))
  );
}
