// Removes personal identifiers from review text before it reaches a model (security.md §7, BF-029): e-mail addresses,
// links, social handles, phone numbers, the names the source attached (author, reply signature) and names
// introduced by a title or a thank-you ("Merci Julie", "ask for Mr Smith"). Placeholders keep the sentence readable.
// Best effort by design: free-text names cannot all be found, so the prompt also forbids names in paraphrases and
// paraphrases are checked again before they are kept.

export const PLACEHOLDERS = {
  person: '[person]',
  email: '[email]',
  phone: '[phone]',
  handle: '[handle]',
  link: '[link]',
} as const;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]+/giu;
/** `@name` not preceded by a word character (so e-mails, already replaced, and "a@b" are not handles). */
const HANDLE = /(?<![\p{L}\p{N}_])@[\p{L}\p{N}_.]{2,30}/gu;
/** Eight or more digits, possibly with spaces, dots, dashes, slashes or parentheses, optional leading +. */
const PHONE = /(?<![\p{N}])\+?\(?\p{N}(?:[\s.\-/()]{0,2}\p{N}){7,15}(?![\p{N}])/gu;

// Capitalized words, without the `i` flag: with /iu, \p{Lu} also matches lowercase letters.
const NAME = String.raw`\p{Lu}[\p{Ll}'’-]+(?:[\s-]\p{Lu}[\p{Ll}'’-]+)?`;
const TITLES = String.raw`(?:M\.|Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Mme|Mlle|Monsieur|Madame|Mademoiselle|Sir|Miss|Chef)`;
const THANKS =
  '(?:[Mm]erci|[Tt]hanks?|[Tt]hank you|[Tt]hx|[Bb]ravo|[Kk]udos(?: to)?|[Gg]rand merci|[Dd]emandez|[Aa]sk for|[Gg]râce à|[Ss]pecial thanks to)';
const TITLED_NAME = new RegExp(String.raw`\b${TITLES}\s+${NAME}`, 'gu');
// The thank-you word stays, the name goes: "Merci [person] !".
const THANKED_NAME = new RegExp(String.raw`(${THANKS}(?:\s+à)?\s+)${NAME}`, 'gu');
/** Words a thank-you is often followed by that are not names. */
const NOT_NAMES = new Set([
  'Beaucoup',
  'Encore',
  'Pour',
  'For',
  'Again',
  'Everyone',
  'All',
  'Tous',
  'Toute',
  'Toutes',
  'Team',
  'The',
  'Vous',
  'You',
  "L'équipe",
  'Equipe',
  'Équipe',
]);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Each attached name, and each of its words of 3+ letters ("Marie D." → "Marie D.", "Marie"). */
function nameVariants(names: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const name of names) {
    const trimmed = name.normalize('NFKC').trim();
    if (trimmed.length < 2) continue;
    variants.add(trimmed);
    for (const word of trimmed.split(/[\s.]+/u)) if (word.length >= 3) variants.add(word);
  }
  // Longest first: "Marie Dupont" before "Marie".
  return [...variants].sort((a, b) => b.length - a.length);
}

export function stripPersonalDetails(text: string, knownNames: readonly string[] = []): string {
  let clean = text
    .normalize('NFKC')
    .replace(EMAIL, PLACEHOLDERS.email)
    .replace(LINK, PLACEHOLDERS.link)
    .replace(HANDLE, PLACEHOLDERS.handle)
    .replace(PHONE, PLACEHOLDERS.phone);
  for (const name of nameVariants(knownNames)) {
    clean = clean.replace(
      new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRegExp(name)}(?![\p{L}\p{N}])`, 'giu'),
      PLACEHOLDERS.person,
    );
  }
  clean = clean.replace(TITLED_NAME, PLACEHOLDERS.person).replace(THANKED_NAME, (match, lead: string) => {
    const name = match.slice(lead.length);
    const first = name.split(/[\s-]/u)[0] ?? name;
    return NOT_NAMES.has(first) ? match : `${lead}${PLACEHOLDERS.person}`;
  });
  return clean.replace(/[ \t]+/g, ' ').trim();
}
