import type { Locale } from '@bf/contracts';

/** Lowercase, accents removed, apostrophes and punctuation to spaces, whitespace collapsed. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[’'`]/g, ' ')
    .replace(/[^\p{L}\p{N},.\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Prompt normalized for caching: same words, same key. */
export function normalizePrompt(prompt: string): string {
  return prompt.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Short prompts defeat statistical detectors (franc needs ~50+ characters), so count function words and
// trade words typical of each language; accents tip ties towards French; the UI locale breaks remaining ties.
// Words shared with English or common in English prompts ("note", "location", "plus", "en") are left out.
const words = (text: string) => new Set(text.split(' '));
const FRENCH = words(
  'au aux de des du et la le les leur mes moins nos notre ou par pour pres qui sur avis etoiles coiffure ' +
    'boulangerie boulangeries agences agence loueurs plombiers electriciens trouve trouver tous toutes mon ma ' +
    'cette semaine mois',
);
/** Function words that only French uses: one outweighs an English borrowing ("spas avec rooftop"). */
const FRENCH_ONLY = words('sans avec dans');
const ENGLISH = words(
  'the in at near with without and or my our for of less fewer more than below above least rated reviews ' +
    'website stars find all shops stores agencies rental rentals this week month new best closest that',
);

export function detectLanguage(prompt: string, fallback: Locale): Locale {
  const tokens = fold(prompt)
    .split(/[\s,.]+/)
    .filter(Boolean);
  let fr = 0;
  for (const token of tokens) {
    if (FRENCH_ONLY.has(token)) fr += 2;
    else if (FRENCH.has(token)) fr += 1;
  }
  const en = tokens.filter((w) => ENGLISH.has(w)).length;
  if (/[éèêàùçôîœ]/i.test(prompt)) fr += 0.5;
  if (fr === en) return fallback;
  return fr > en ? 'fr' : 'en';
}
