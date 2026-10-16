// Site slugs (BF-035): the preview subdomain `<slug>.<SITES_BASE_DOMAIN>`, made from the business name and locality.
// ASCII only (French and other accents transliterated), at most 40 characters, never one of our hostnames, never an
// offensive or phishing word, and with a random suffix: preview addresses cannot be guessed or squatted, and two
// workspaces' sites of one business never learn about each other.

export const SITE_SLUG_MAX = 40;
/** The random part's length: preview addresses cannot be guessed from a business's name. */
export const SUFFIX_LENGTH = 6;

/** Subdomains that name our own services. */
export const RESERVED_SITE_SLUGS: ReadonlySet<string> = new Set([
  'www',
  'app',
  'api',
  'admin',
  'mail',
  'docs',
  'status',
  'static',
  'cdn',
  'assets',
  'preview',
]);

/** Stems a slug never shows, even inside a word (`fuckin`): long and unambiguous, EN and FR. */
const BLOCKED_STEMS: readonly string[] = [
  'fuck',
  'bitch',
  'merde',
  'putain',
  'salope',
  'connard',
  'connasse',
  'encule',
  'nazi',
];
/**
 * Short words a slug never shows as words only: inside a word they are innocent (Sussex, Essex, computer, réputé,
 * habite, Pornic, shiitake, Scunthorpe).
 */
const BLOCKED_WORDS: ReadonlySet<string> = new Set([
  'shit',
  'porn',
  'porno',
  'sex',
  'sexy',
  'xxx',
  'cunt',
  'pute',
  'putes',
  'bite',
  'cul',
]);

/** Words of phishing pages and brands a preview address never carries (`paypal-login-secure`). */
const PHISHING_WORDS: ReadonlySet<string> = new Set([
  'login',
  'signin',
  'verify',
  'verification',
  'secure',
  'account',
  'password',
  'wallet',
  'bank',
  'paypal',
  'apple',
  'google',
  'microsoft',
  'amazon',
  'facebook',
  'instagram',
  'netflix',
  'support',
  'update',
]);

/** A random suffix that spells a blocked word or stem somewhere in it (`sexk2p`): drawn again. */
export const suffixSpellsWord = (suffix: string) =>
  [...BLOCKED_WORDS, ...BLOCKED_STEMS].some((word) => suffix.includes(word));

/** A word of a slug that is left out (a slug's words are its hyphen-separated parts). */
export const blocked = (word: string) =>
  PHISHING_WORDS.has(word) || BLOCKED_WORDS.has(word) || BLOCKED_STEMS.some((stem) => word.includes(stem));

/** Letters NFKD does not decompose into ASCII. */
const LETTERS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
};

/** Text as lowercase ASCII words joined by dashes (`Café de l'Église` → `cafe-de-l-eglise`). */
export function transliterate(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (letter) => LETTERS[letter] ?? letter)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Cut at a dash so no word is split, within `max` characters. */
function cut(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max + 1);
  const at = head.lastIndexOf('-');
  return (at > 0 ? head.slice(0, at) : slug.slice(0, max)).replace(/-+$/, '');
}

/**
 * The readable part of a business's slug: its name and locality, transliterated, offensive and phishing words
 * dropped, at most 33 characters (the random suffix completes it to 40). A name with nothing left is `site`.
 */
export function baseSlug(name: string, locality?: string | null): string {
  const words = transliterate(name)
    .split('-')
    .filter((word) => word !== '' && !blocked(word));
  const place = transliterate(locality ?? '')
    .split('-')
    .filter((word) => word !== '' && !blocked(word));
  // The locality is added unless the name already ends with it (whole words).
  const named = words.join('-');
  const where = place.join('-');
  const withPlace = where && !`-${named}-`.includes(`-${where}-`) ? [...words, ...place] : words;
  if (words.length === 0) withPlace.unshift('site');
  return cut(withPlace.join('-') || 'site', SITE_SLUG_MAX - SUFFIX_LENGTH - 1);
}

/** A preview slug: the readable base and a random suffix (`salon-lumiere-gustavia-k3x9p2`), ≤ 40 characters. */
export const previewSlug = (base: string, suffix: string) =>
  `${cut(base, SITE_SLUG_MAX - suffix.length - 1)}-${suffix}`;

/** A slug the API accepts (the database checks the same shape). */
export const isValidSlug = (slug: string) =>
  /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(slug) && !RESERVED_SITE_SLUGS.has(slug);
