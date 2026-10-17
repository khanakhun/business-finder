// Which jurisdiction's rules apply to a recipient (BF-049), pure: the business's country (Saint-Barthélemy and
// Saint-Martin by their postcodes, since the country field may say FR or GP), else its phone's country code, else
// its email's country domain. Disagreeing signals keep every candidate (the stricter result wins later); nothing
// known is `*`. Jurisdictions without a seeded policy fall back to `*` (manual only).

export const SEEDED_JURISDICTIONS = new Set(['US', 'FR', 'BL', 'MF', 'NL', 'BE', 'DE', 'GB']);

const POSTCODE_TERRITORY: ReadonlyArray<readonly [RegExp, string]> = [
  [/^97133$/, 'BL'],
  [/^97150$/, 'MF'],
];

/** Calling codes of the seeded jurisdictions (+590 is shared by BL, MF and Guadeloupe: not conclusive alone). */
const CALLING_CODES: ReadonlyArray<readonly [string, string[]]> = [
  ['+590', ['BL', 'MF']],
  ['+33', ['FR']],
  ['+31', ['NL']],
  ['+32', ['BE']],
  ['+49', ['DE']],
  ['+44', ['GB']],
  ['+1', ['US']],
];

const CCTLDS: Readonly<Record<string, string>> = {
  fr: 'FR',
  bl: 'BL',
  mf: 'MF',
  nl: 'NL',
  be: 'BE',
  de: 'DE',
  uk: 'GB',
};

const seeded = (code: string) => (SEEDED_JURISDICTIONS.has(code) ? code : '*');

export function resolveJurisdictions(signals: {
  readonly countryCode: string | null;
  readonly postalCode: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}): string[] {
  const candidates = new Set<string>();
  const postcode = signals.postalCode?.replace(/\s/g, '') ?? '';
  const territory = POSTCODE_TERRITORY.find(([pattern]) => pattern.test(postcode))?.[1];
  if (territory) candidates.add(territory);
  else if (signals.countryCode) candidates.add(seeded(signals.countryCode.toUpperCase()));
  if (candidates.size === 0 && signals.phone) {
    const match = CALLING_CODES.find(([prefix]) => signals.phone?.startsWith(prefix));
    if (match) for (const code of match[1]) candidates.add(code);
  }
  if (candidates.size === 0 && signals.email) {
    const tld = signals.email.split('.').pop()?.toLowerCase() ?? '';
    const code = CCTLDS[tld];
    if (code) candidates.add(code);
  }
  if (candidates.size === 0) candidates.add('*');
  return [...candidates].sort();
}
