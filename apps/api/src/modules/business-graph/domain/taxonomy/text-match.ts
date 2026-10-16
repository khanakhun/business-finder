// Accent-insensitive FR/EN phrase matching of business names and provider labels against category labels and
// synonyms (the classifier's synonym step, BF-015). Pure: the index is built from the cached taxonomy.

/** Words that never identify a trade on their own. */
const STOPWORDS = new Set([
  'le',
  'la',
  'les',
  'l',
  'de',
  'du',
  'des',
  'd',
  'et',
  'en',
  'au',
  'aux',
  'a',
  'chez',
  'un',
  'une',
  'sur',
  'pour',
  'the',
  'of',
  'and',
  'at',
  'in',
  'on',
  'for',
  'by',
  'to',
  'an',
  's',
  'st',
  'saint',
  'sainte',
]);

/** Lowercase, unaccented, letters/digits only, single spaces (`L'Épicerie-Fine` → `l epicerie fine`). */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Light FR/EN plural folding, applied to phrases and texts alike: `salons` → `salon`, `bijoux` → `bijou`,
 * `quincailleries` → `quincaillerie`; English `-y` and French `-ie` meet (`pharmacy`, `pharmacies`, `pharmacie`).
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return word.slice(0, -1);
  if (word.endsWith('y')) return `${word.slice(0, -1)}ie`;
  if (word.endsWith('eaux') || word.endsWith('oux')) return word.slice(0, -1);
  if (word.endsWith('aux') && word.length > 4) return `${word.slice(0, -3)}al`;
  if (word.endsWith('is') && NOT_PLURAL_IS.has(word)) return word;
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

/** Singular words ending in -is (otherwise `taxis` → `taxi`). */
const NOT_PLURAL_IS = new Set([
  'tennis',
  'paris',
  'devis',
  'permis',
  'tapis',
  'souris',
  'palais',
  'logis',
  'oasis',
  'chassis',
  'jadis',
  'avis',
  'mais',
  'pais',
  'fois',
  'tamis',
  'radis',
  'parvis',
  'croquis',
  'gratis',
  'ibis',
  'iris',
  'lapis',
  'vernis',
]);

export function tokens(text: string): string[] {
  return normalizeText(text).split(' ').filter(Boolean).map(stem);
}

export interface PhraseSource {
  readonly slug: string;
  /** Labels and synonyms in any language. */
  readonly phrases: readonly string[];
}

interface IndexedPhrase {
  readonly slug: string;
  readonly tokens: readonly string[];
}

export interface SynonymIndex {
  /** First token → phrases starting with it (phrases of stopwords only are dropped). */
  readonly byFirstToken: ReadonlyMap<string, readonly IndexedPhrase[]>;
}

export function buildSynonymIndex(sources: readonly PhraseSource[]): SynonymIndex {
  const byFirstToken = new Map<string, IndexedPhrase[]>();
  for (const source of sources) {
    for (const phrase of source.phrases) {
      const phraseTokens = tokens(phrase);
      if (phraseTokens.length === 0 || phraseTokens.every((t) => STOPWORDS.has(t))) continue;
      const first = phraseTokens[0] as string;
      const list = byFirstToken.get(first) ?? [];
      if (!list.some((p) => p.slug === source.slug && p.tokens.join(' ') === phraseTokens.join(' '))) {
        list.push({ slug: source.slug, tokens: phraseTokens });
      }
      byFirstToken.set(first, list);
    }
  }
  return { byFirstToken };
}

export interface SynonymMatch {
  readonly slug: string;
  /** 0–1: longer (more specific) phrases score higher. */
  readonly score: number;
  readonly phrase: string;
}

/**
 * Categories whose label or synonym appears as a whole-word phrase in one of `texts`. Multi-word phrases score
 * above single words; a one-word phrase of ≤ 2 letters is too ambiguous and is ignored.
 */
export function matchSynonyms(index: SynonymIndex, texts: readonly string[]): SynonymMatch[] {
  const best = new Map<string, SynonymMatch>();
  for (const text of texts) {
    const words = tokens(text);
    words.forEach((word, start) => {
      for (const phrase of index.byFirstToken.get(word) ?? []) {
        const n = phrase.tokens.length;
        if (n === 1 && word.length <= 2) continue;
        if (!phrase.tokens.every((t, i) => words[start + i] === t)) continue;
        const letters = phrase.tokens.join('').length;
        const score = Math.min(0.95, (n > 1 ? 0.82 : 0.72) + Math.min(letters, 20) * 0.005);
        const current = best.get(phrase.slug);
        if (!current || score > current.score) {
          best.set(phrase.slug, { slug: phrase.slug, score, phrase: phrase.tokens.join(' ') });
        }
      }
    });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}
