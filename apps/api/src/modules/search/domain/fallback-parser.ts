import type { ParseSearchIntentOutput } from '@bf/ai';
import { type Locale, type PipelineStatus, SEARCH_INTENT_WARNINGS } from '@bf/contracts';
import { fold } from './text.ts';

// Deterministic intent parser (BF-021): used when the model is unavailable (no key, budget spent, provider down)
// or answered outside its candidates. It knows category labels and synonyms, location phrases after a
// preposition, postcodes and the common filters; anything subtler waits for the model. Low confidence by design.

export interface FallbackCategory {
  readonly slug: string;
  readonly labels: { readonly en: string; readonly fr: string };
  readonly synonyms: { readonly en: readonly string[]; readonly fr: readonly string[] };
}

export const FALLBACK_CONFIDENCE = 0.4;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const number = (text: string) => Number(text.replace(',', '.'));

/** "salons de coiffure" also matches "salon de coiffure" and the reverse (s/x plurals, per word). */
function termPattern(term: string): RegExp | null {
  const words = fold(term).split(' ').filter(Boolean);
  if (words.length === 0 || words.join('').length < 3) return null;
  const variants = words.map((w) => {
    const stem = w.replace(/(s|x)$/, '');
    return stem.length >= 3 ? `${escapeRegex(stem)}(?:s|x|es)?` : escapeRegex(w);
  });
  return new RegExp(`(?:^|[\\s,.-])${variants.join('\\s+')}(?=$|[\\s,.-])`);
}

function matchCategories(text: string, categories: readonly FallbackCategory[]): string[] {
  const matched: string[] = [];
  for (const category of categories) {
    const terms = [
      category.labels.en,
      category.labels.fr,
      ...category.synonyms.en,
      ...category.synonyms.fr,
      category.slug.replace(/_/g, ' '),
    ];
    if (terms.some((term) => termPattern(term)?.test(text))) matched.push(category.slug);
  }
  return matched.slice(0, 10);
}

const PLACE_WORD = String.raw`(?:\p{Lu}[\p{L}'’.]*(?:-\p{L}[\p{L}'’.]*)*)`;
const LINKER = String.raw`(?:(?:de|du|des|la|le|les)\s)`;
const PLACE = String.raw`${PLACE_WORD}(?:[\s-]${LINKER}?${PLACE_WORD})*`;
const POSTCODE = String.raw`(?:\d{4}\s?\p{Lu}{2}|\d{4,5})(?:,?\s${PLACE})?`;
// Prepositions match in any case ("In Gustavia", "À Lorient"); the place itself must start with a capital or be a
// postcode, so it is matched separately and case-sensitively (a /iu \p{Lu} would also match lowercase letters).
const PREPOSITION = /(?<=^|[\s,(])(in|at|near|around|dans|en|au|aux|sur|à|a|pr[eè]s\s+de|autour\s+de)\s+/giu;
/** A lowercase article between the preposition and the place: "in the Marais", "à la Rochelle", "à l'Anse". */
const ARTICLE = /([Tt]he|la|le|les)\s+|l['’]/y;
const PLACE_AT = new RegExp(`${POSTCODE}|${PLACE}`, 'uy');
/** Words that start with a capital letter but are not places (sentence starts, trades). */
const NOT_PLACES = new Set([
  'my',
  'mes',
  'nos',
  'our',
  'the',
  'les',
  'find',
  'trouve',
  // Platforms and languages read like places after "on"/"in"/"sur": "avis sur Google", "menus in English".
  'google',
  'facebook',
  'instagram',
  'tripadvisor',
  'english',
  'french',
  'anglais',
  'français',
  'francais',
]);
/** Capitalised words that end a place ("Gustavia Sans Site Web", "St Barth With Email"). */
const PLACE_STOPS = new Set([
  'sans',
  'avec',
  'with',
  'without',
  'and',
  'et',
  'or',
  'ou',
  'but',
  'mais',
  'pour',
  'for',
  'rated',
  'note',
  'qui',
  'that',
  'least',
  'moins',
]);

function placeAt(prompt: string, index: number): string | null {
  PLACE_AT.lastIndex = index;
  const raw = PLACE_AT.exec(prompt)?.[0];
  if (!raw) return null;
  const words: string[] = [];
  for (const word of raw.split(/\s+/)) {
    if (PLACE_STOPS.has(fold(word))) break;
    words.push(word);
  }
  // A cut can leave a dangling linker ("Anse de Stop" → "Anse de").
  while (words.length > 1 && /^(?:de|du|des|la|le|les)$/.test(words.at(-1) ?? '')) words.pop();
  const text = words.join(' ').trim().replace(/[.,]$/, '');
  return text && !NOT_PLACES.has(text.toLowerCase()) ? text : null;
}

/**
 * The first place named after a preposition. A bare "a" counts only in French (accentless "a Gustavia"); in
 * English it is an article. After "à", "la" belongs to the name ("à la Rochelle"); other articles are dropped.
 */
export function extractLocation(prompt: string, language: Locale = 'en'): string | null {
  for (const match of prompt.matchAll(PREPOSITION)) {
    const preposition = (match[1] ?? '').toLowerCase();
    if (preposition === 'a' && language !== 'fr') continue;
    let index = (match.index ?? 0) + match[0].length;
    ARTICLE.lastIndex = index;
    const article = ARTICLE.exec(prompt);
    if (article) index = ARTICLE.lastIndex;
    const place = placeAt(prompt, index);
    if (!place) continue;
    const keepArticle = article?.[1] === 'la' && (preposition === 'à' || preposition === 'a');
    return keepArticle ? `la ${place}` : place;
  }
  return null;
}

/**
 * "my", "our", "mes"… followed by a lowercase word: the prompt is about the workspace's own pipeline. Matched on
 * the raw prompt, between spaces, so names such as "Notre-Dame" or "Ma Cuisine" are not possessives.
 */
const POSSESSIVE = /(?:^|\s)(?:[Mm]y|[Oo]ur|[Mm]es|[Nn]os|[Mm]on|[Mm]a|[Nn]otre)\s+(?=\p{Ll})/u;
// Pipeline words count only after a possessive: "my qualified spas" is a pipeline query, "qualified plumbers" is not.
const PIPELINE_WORDS: ReadonlyArray<[RegExp, PipelineStatus]> = [
  [/\b(qualified|qualifie[es]{0,2})\b/, 'qualified'],
  [/\b(contacted|contacte[es]{0,2})\b/, 'contacted'],
  // Folding turns "won't" into "won t".
  [/\b(won(?! t\b)|gagne[es]{0,2})\b/, 'won'],
  [/\b(lost|perdu[es]{0,2})\b/, 'lost'],
];

function pipelineStatuses(prompt: string): PipelineStatus[] {
  const owner = POSSESSIVE.exec(prompt);
  if (!owner) return [];
  const after = fold(prompt.slice(owner.index));
  return PIPELINE_WORDS.filter(([pattern]) => pattern.test(after)).map(([, status]) => status);
}

type Filters = ParseSearchIntentOutput['filters'];

function extractFilters(text: string): Filters {
  const filters: Filters = {
    website: 'any',
    minRating: null,
    maxRating: null,
    minReviews: null,
    maxReviews: null,
    hasEmail: null,
    hasPhone: null,
    emailVerified: null,
    languages: [],
    priceLevels: [],
    painSignals: [],
    minScore: null,
    tiers: [],
    pipelineStatuses: [],
    tags: [],
    addedWithinDays: null,
  };
  const site = String.raw`(?:web\s?site|site(?: web| internet)?)`;
  if (new RegExp(String.raw`\b(?:without|no) (?:a )?${site}|\bsans ${site}|\bpas de ${site}`).test(text)) {
    filters.website = 'none';
  } else if (
    new RegExp(
      String.raw`\b(?:slow|outdated|old|bad|poor) ${site}|\b${site} (?:lent|obsolete|vieillot|ancien)`,
    ).test(text)
  ) {
    filters.website = 'weak';
  } else if (new RegExp(String.raw`\bwith (?:a |an )?(?:\w+ )?${site}|\bavec (?:un )?${site}`).test(text)) {
    filters.website = 'has';
  }
  const email = `(?:e-?mail|courriel|mail)`;
  if (new RegExp(String.raw`\b(?:no|without|sans|pas d) ?${email}`).test(text)) filters.hasEmail = false;
  else if (new RegExp(String.raw`\b(?:with|has|avec) (?:a |an |un )?(?:verified )?${email}`).test(text)) {
    filters.hasEmail = true;
  }
  if (new RegExp(`verified ${email}|${email} verifie`).test(text)) {
    filters.emailVerified = true;
    filters.hasEmail = true;
  }
  const phone = `(?:(?:a |un )?(?:numero de )?(?:phone|telephone))`;
  if (new RegExp(String.raw`\b(?:without|no|sans|pas de) ${phone}`).test(text)) filters.hasPhone = false;
  else if (new RegExp(String.raw`\b(?:with|has|avec) ${phone}`).test(text)) filters.hasPhone = true;
  // One digit, optional decimal, never the start of a longer number ("below 45 stars" is not a rating).
  const rating = String.raw`(\d(?:[.,]\d)?)(?![\d.,]*\d)`;
  const max =
    new RegExp(`rated (?:below|under) ${rating}`).exec(text) ??
    new RegExp(`(?:below|under|less than) ${rating} stars?`).exec(text) ??
    new RegExp(`note (?:inferieure|en dessous) (?:a|de) ${rating}`).exec(text) ??
    new RegExp(`moins de ${rating} etoiles?`).exec(text);
  if (max?.[1]) filters.maxRating = number(max[1]);
  const min =
    new RegExp(`rated (?:above|over|at least) ${rating}`).exec(text) ??
    new RegExp(`(?:at least|over|above|minimum) ${rating} stars?`).exec(text) ??
    new RegExp(`au moins ${rating} etoiles?`).exec(text);
  if (min?.[1]) filters.minRating = number(min[1]);
  const fewer = /(?:fewer|less) than (\d+) reviews?|moins de (\d+) avis/.exec(text);
  if (fewer) filters.maxReviews = Math.max(0, Number(fewer[1] ?? fewer[2]) - 1);
  const more = /more than (\d+) reviews?|plus de (\d+) avis/.exec(text);
  if (more) filters.minReviews = Number(more[1] ?? more[2]) + 1;
  const atLeast = /at least (\d+) reviews?|au moins (\d+) avis/.exec(text);
  if (atLeast) filters.minReviews = Number(atLeast[1] ?? atLeast[2]);
  if (/\b(?:this week|cette semaine)\b/.test(text)) filters.addedWithinDays = 7;
  else if (/\b(?:this month|ce mois)\b/.test(text)) filters.addedWithinDays = 30;
  return filters;
}

function extractSort(text: string): ParseSearchIntentOutput['sort'] {
  if (/\b(?:best rated|top rated|mieux notee?s?)\b/.test(text)) return { field: 'rating', direction: 'desc' };
  if (/\b(?:most reviewed|plus commentee?s?)\b/.test(text)) return { field: 'reviews', direction: 'desc' };
  if (/\b(?:closest|nearest|plus proches?)\b/.test(text)) return { field: 'distance', direction: 'asc' };
  if (/\b(?:newest|plus recents?)\b/.test(text)) return { field: 'recent', direction: 'desc' };
  return { field: 'relevance', direction: 'desc' };
}

export function parseIntentFallback(
  prompt: string,
  language: Locale,
  categories: readonly FallbackCategory[],
): ParseSearchIntentOutput {
  const text = fold(prompt);
  const filters = { ...extractFilters(text), pipelineStatuses: pipelineStatuses(prompt) };
  const own = POSSESSIVE.test(prompt);
  // "find 50 cafés" is a target count; "find 5 star hotels" and "find 4.5 rated spas" are not.
  const limit = /\b(?:find|trouve[rz]?)\s+(\d{1,4})(?![\d.,]|\s*-?\s*(?:stars?|etoiles?)\b)/.exec(text);
  return {
    mode: own ? 'listings' : 'both',
    categoryIds: matchCategories(text, categories),
    keywords: [],
    locationText: extractLocation(prompt, language),
    filters,
    sort: extractSort(text),
    limit: limit?.[1] ? Number(limit[1]) : null,
    needsClarification: null,
    confidence: FALLBACK_CONFIDENCE,
    warnings: [
      language === 'fr'
        ? `${SEARCH_INTENT_WARNINGS.fallback}: lecture simplifiée, vérifiez les filtres.`
        : `${SEARCH_INTENT_WARNINGS.fallback}: simplified reading, check the filters.`,
    ],
  };
}
