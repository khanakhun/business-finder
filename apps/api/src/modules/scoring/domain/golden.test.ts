import { readFileSync } from 'node:fs';
import { OFFERS } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { GOLDEN } from './__fixtures__/golden.ts';
import { BUILTIN_PROFILES } from './builtin-profiles.ts';
import { scoreBusiness } from './engine.ts';

// Golden test (BF-031): the expected tier and deciding gate of each fixture business per built-in profile, in offer
// order (new_website, website_redesign, ai_receptionist, booking_system, local_seo). A weight change that moves a
// tier must update this table, the PR's golden table and docs/scoring/profiles.md together.
const EXPECTED: [string, string, (string | null)[]][] = [
  ['Beach bistro, no website, busy', 'ACCBB', [null, 'no_website_to_redesign~', null, null, null]],
  ['Salon, Facebook page only, phone pains', 'ACAAC', [null, 'no_website_to_redesign~', null, null, null]],
  ['Villa rental, dated slow site', 'BABAA', [null, null, null, null, null]],
  [
    'Hotel, strong site, books online',
    'CCBCB',
    ['has_working_website', null, null, 'already_books_online', null],
  ],
  ['Dentist, ok site, no booking', 'CCBAC', ['has_working_website', null, null, null, null]],
  ['Gift shop, parked domain', 'BCCCC', [null, 'no_website_to_redesign~', null, 'offer_rarely_fits', null]],
  [
    'Permanently closed café',
    'XXXXX',
    [
      'closed_permanently',
      'closed_permanently',
      'closed_permanently',
      'closed_permanently',
      'closed_permanently',
    ],
  ],
  [
    'Do-not-contact bakery',
    'XXXXX',
    ['do_not_contact', 'do_not_contact', 'do_not_contact', 'do_not_contact', 'do_not_contact'],
  ],
  [
    'Garage, unreachable',
    'CCCCC',
    ['unreachable', 'no_website_to_redesign~', 'unreachable~', 'offer_rarely_fits~', 'unreachable~'],
  ],
  ['Spa, broken site, many complaints', 'BCACC', [null, null, null, 'booking_not_checked', null]],
  [
    'Chain boutique, shared website',
    'CCCCC',
    ['has_working_website~', null, null, 'offer_rarely_fits', null],
  ],
  [
    'Won customer, no website',
    'CCCCC',
    [
      'already_customer',
      'no_website_to_redesign~',
      'already_customer~',
      'already_customer',
      'already_customer',
    ],
  ],
];

const results = (name: string) => {
  const facts = GOLDEN[name];
  if (!facts) throw new Error(`No golden business ${name}`);
  return OFFERS.map((offer) => scoreBusiness(BUILTIN_PROFILES[offer], facts));
};

describe('built-in profiles (golden)', () => {
  it.each(EXPECTED)('%s → %s', (name, tiers, gates) => {
    const scored = results(name);
    expect(scored.map((result) => result.tier).join('')).toBe(tiers);
    // A cap that matched without lowering the score is marked `~` (not applied).
    expect(
      scored.map((result) =>
        result.gated ? `${result.gated.gate}${result.gated.applied ? '' : '~'}` : null,
      ),
    ).toEqual(gates);
  });

  it('covers every golden business', () => {
    expect(EXPECTED.map(([name]) => name).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  const all = Object.keys(GOLDEN).flatMap(results);

  it('explains every excluded score by its gate alone, in both languages', () => {
    const excluded = all.filter((result) => result.tier === 'X');
    expect(excluded.length).toBeGreaterThan(0);
    for (const result of excluded) {
      expect(result.reasons).toEqual([]);
      expect(result.gated?.reason.fr).toBeTruthy();
    }
  });

  it('explains every other score with filled reasons in both languages', () => {
    const scored = all.filter((result) => result.tier !== 'X');
    for (const result of scored) expect(result.reasons.length).toBeGreaterThan(0);
    // A low category relevance never reads as "often needs this offer".
    const relevance = scored.flatMap((result) =>
      result.reasons
        .filter((reason) => reason.feature === 'category_offer_relevance')
        .map((reason) => ({ value: result.features.category_offer_relevance, text: reason.text.en })),
    );
    expect(relevance.filter(({ value, text }) => Number(value) < 0.5 && text.includes('often'))).toEqual([]);
    for (const reason of scored.flatMap((result) => result.reasons)) {
      expect(reason.text.en).not.toMatch(/\{value\}|null|undefined|NaN/);
      expect(reason.text.fr).not.toMatch(/\{value\}|null|undefined|NaN/);
    }
  });
});

describe('docs/scoring/profiles.md', () => {
  const doc = readFileSync(new URL('../../../../../../docs/scoring/profiles.md', import.meta.url), 'utf8');

  it('documents exactly the weights of each built-in profile', () => {
    for (const offer of OFFERS) {
      const section = doc.split(`## \`${offer}\``)[1]?.split('\n## ')[0] ?? '';
      const documented = Object.fromEntries(
        [...section.matchAll(/^\| `([a-z_.]+)` \| (−?\d+) \|/gm)].map((m) => [
          m[1],
          Number(m[2]?.replace('−', '-')),
        ]),
      );
      expect(documented, offer).toEqual(BUILTIN_PROFILES[offer].weights);
    }
  });

  it('shows the golden table', () => {
    const table = doc.split('## Golden table')[1] ?? '';
    for (const [name, tiers] of EXPECTED) {
      const row = table.split('\n').find((line) => line.startsWith(`| ${name} |`));
      expect(
        row
          ?.split('|')
          .slice(2, 7)
          .map((cell) => cell.trim())
          .join(''),
        name,
      ).toBe(tiers);
    }
  });
});
