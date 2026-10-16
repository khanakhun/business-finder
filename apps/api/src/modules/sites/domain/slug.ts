// Site slugs (BF-035): the preview subdomain `<slug>.<SITES_BASE_DOMAIN>`, made from the business name and locality.
// ASCII only (French and other accents transliterated), at most 40 characters, never one of our hostnames, never an
// offensive word; uniqueness across all sites comes from a numeric suffix the caller tries in turn.

export const SITE_SLUG_MAX = 40;

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

/** Words a slug never shows (as a whole word); kept short and generic, EN and FR. */
const BLOCKED_WORDS: ReadonlySet<string> = new Set([
  'fuck',
  'shit',
  'porn',
  'sex',
  'xxx',
  'nazi',
  'cunt',
  'bitch',
  'merde',
  'putain',
  'salope',
  'connard',
  'connasse',
  'encule',
  'pute',
  'bite',
]);

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

/** The slug a business gets first: its name and locality, transliterated, clean and at most 40 characters. */
export function baseSlug(name: string, locality?: string | null): string {
  const words = transliterate(name)
    .split('-')
    .filter((word) => word !== '' && !BLOCKED_WORDS.has(word));
  const place = locality ? transliterate(locality) : '';
  // The locality is added unless the name already says it.
  const withPlace = place && !words.join('-').includes(place) ? [...words, place] : words;
  let slug = cut(withPlace.join('-'), SITE_SLUG_MAX);
  if (slug === '') slug = 'site';
  if (RESERVED_SITE_SLUGS.has(slug)) slug = `${slug}-site`;
  return slug;
}

/** The n-th candidate (1 is the base itself): `salon-gustavia`, `salon-gustavia-2`, … always ≤ 40 characters. */
export function slugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${cut(base, SITE_SLUG_MAX - suffix.length)}${suffix}`;
}

/** A slug the API accepts (the database checks the same shape). */
export const isValidSlug = (slug: string) =>
  /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(slug) && !RESERVED_SITE_SLUGS.has(slug);
