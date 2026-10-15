// Name similarity for entity resolution (BF-016), implemented locally (small, dependency-free, tested): Jaro–Winkler
// for typos and short variants, token-set ratio for reordered or decorated names ("Le Tamarin" / "Tamarin Restaurant").

/** Jaro–Winkler similarity in [0, 1] (prefix scale 0.1, up to 4 characters). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 1 : 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(b.length - 1, i + window);
    for (let j = from; j <= to; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Words that say what kind of place it is or are filler, not which one: dropped before comparing names so
 * "Tamarin Restaurant" and "Le Tamarin" compare as "tamarin" / "tamarin".
 */
const GENERIC_WORDS = new Set([
  // articles, prepositions, filler (FR/EN)
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
  'the',
  'of',
  'and',
  'at',
  'in',
  'on',
  'by',
  's',
  'st',
  'saint',
  'sainte',
  'sbh',
  'sxm',
  'gustavia',
  'barth',
  'barthelemy',
  // trade words
  'restaurant',
  'resto',
  'bar',
  'cafe',
  'coffee',
  'hotel',
  'villa',
  'villas',
  'boutique',
  'shop',
  'store',
  'salon',
  'spa',
  'snack',
  'bistro',
  'brasserie',
  'pizzeria',
  'beach',
  'club',
  'lounge',
  'agence',
  'agency',
  'services',
  'service',
  'location',
  'rental',
  'rentals',
  'studio',
  'center',
  'centre',
  'company',
  'co',
  'group',
  'groupe',
]);

/** Significant tokens of an already normalized name (lowercase, unaccented, legal forms stripped). */
export function significantTokens(normalizedName: string): string[] {
  const words = normalizedName.split(' ').filter(Boolean);
  const kept = words.filter((w) => !GENERIC_WORDS.has(w));
  // A name made only of generic words ("Le Bar") is compared as written.
  return kept.length > 0 ? kept : words;
}

/**
 * Token-set ratio in [0, 1]: compares the shared tokens with each side's full token set (fuzzy at word level,
 * so "chez jo s" vs "chez joe" still scores high).
 */
export function tokenSetRatio(aTokens: readonly string[], bTokens: readonly string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const a = [...new Set(aTokens)].sort();
  const b = [...new Set(bTokens)].sort();
  const shared = a.filter((t) => b.includes(t));
  const onlyA = a.filter((t) => !b.includes(t));
  const onlyB = b.filter((t) => !a.includes(t));
  const base = shared.join(' ');
  const left = [base, onlyA.join(' ')].filter(Boolean).join(' ');
  const right = [base, onlyB.join(' ')].filter(Boolean).join(' ');
  const scores = [jaroWinkler(left, right)];
  if (base) scores.push(jaroWinkler(base, left), jaroWinkler(base, right));
  return Math.max(...scores);
}

/** Similarity of two normalized business names in [0, 1]. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = significantTokens(a);
  const tb = significantTokens(b);
  return Math.max(jaroWinkler(ta.join(' '), tb.join(' ')), tokenSetRatio(ta, tb));
}
