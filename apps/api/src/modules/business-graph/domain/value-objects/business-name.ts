import { InvalidValueError } from '../errors.ts';

/** Legal forms (FR, EN, NL, DE, …) ignored at the end of a name when comparing names. */
const LEGAL_SUFFIXES = new Set([
  'sarl',
  'sas',
  'sasu',
  'eurl',
  'sa',
  'sci',
  'snc',
  'scop',
  'selarl',
  'ei',
  'eirl',
  'ltd',
  'llc',
  'llp',
  'inc',
  'corp',
  'corporation',
  'co',
  'plc',
  'bv',
  'nv',
  'gmbh',
  'ag',
  'srl',
  'sl',
  'limited',
  'incorporated',
]);

/**
 * Forms also stripped at the start ("SARL Le Bistrot"): only unambiguous French ones, so real words survive
 * ("Sci Fi Café", "Co Working Space"). `spa` is not a legal form here: it is far more often a spa.
 */
const LEADING_LEGAL_FORMS = new Set(['sarl', 'sas', 'sasu', 'eurl', 'selarl', 'snc', 'scop', 'eirl']);

/** A business name: display form, and a normalized form for matching and search. */
export class BusinessName {
  private constructor(
    readonly display: string,
    /** Lowercase, unaccented, punctuation removed, legal suffixes stripped. */
    readonly normalized: string,
  ) {}

  static parse(raw: string): BusinessName {
    const display = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!display || display.length > 200)
      throw new InvalidValueError('name', 'A business needs a name (≤ 200 characters).');
    const words = display
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
    // Strip legal forms ("Bistrot Ltd", "SARL Le Bistrot"), never the whole name.
    while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1) as string)) words.pop();
    while (words.length > 1 && LEADING_LEGAL_FORMS.has(words[0] as string)) words.shift();
    const normalized = words.join(' ');
    if (!normalized) throw new InvalidValueError('name', 'A business needs a name.');
    return new BusinessName(display, normalized);
  }
}
