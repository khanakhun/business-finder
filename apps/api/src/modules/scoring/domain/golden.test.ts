import { readFileSync } from 'node:fs';
import { OFFERS } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { GOLDEN } from './__fixtures__/golden.ts';
import { BUILTIN_PROFILES } from './builtin-profiles.ts';
import { scoreBusiness } from './engine.ts';

// Golden test (BF-031): the expected tier of each fixture business per built-in profile, in offer order
// (new_website, website_redesign, ai_receptionist, booking_system, local_seo). A weight change that moves a tier
// must update this table, the PR's golden table and docs/scoring/profiles.md together.
const EXPECTED: [string, string][] = [
  ['Beach bistro, no website, busy', 'ACCCB'],
  ['Salon, Facebook page only, phone pains', 'ACABC'],
  ['Villa rental, dated slow site', 'BABAA'],
  ['Hotel, strong site, books online', 'CCBCB'],
  ['Dentist, ok site, no booking', 'CCBAC'],
  ['Gift shop, parked domain', 'BCCCC'],
  ['Permanently closed café', 'XXXXX'],
  ['Do-not-contact bakery', 'XXXXX'],
  ['Garage, unreachable', 'CCCCC'],
  ['Spa, broken site, many complaints', 'BCABC'],
  ['Chain boutique, shared website', 'CCCCC'],
  ['Won customer, no website', 'XXXXX'],
];

describe('built-in profiles (golden)', () => {
  it.each(EXPECTED)('%s → %s', (name, tiers) => {
    const facts = GOLDEN[name];
    if (!facts) throw new Error(`No golden business ${name}`);
    expect(OFFERS.map((offer) => scoreBusiness(BUILTIN_PROFILES[offer], facts).tier).join('')).toBe(tiers);
  });

  it('covers every golden business', () => {
    expect(EXPECTED.map(([name]) => name).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  it('explains every non-excluded score with at least one reason in both languages', () => {
    for (const facts of Object.values(GOLDEN)) {
      for (const offer of OFFERS) {
        const result = scoreBusiness(BUILTIN_PROFILES[offer], facts);
        if (result.tier === 'X') {
          expect(result.gated?.reason.fr).toBeTruthy();
          continue;
        }
        expect(result.reasons.length, offer).toBeGreaterThan(0);
        for (const reason of result.reasons) {
          expect(reason.text.en).not.toContain('{value}');
          expect(reason.text.fr).not.toContain('{value}');
        }
      }
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
