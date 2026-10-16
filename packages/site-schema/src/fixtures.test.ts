import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasErrors, SiteSpecSchema, validateSite } from './index.ts';

// The fixture sites (BF-033): four fictional businesses that must validate cleanly, and broken variants that must
// fail with exactly the expected issues.

const OPTIONS = { assetHosts: ['assets.bf-sites.test'], ownDomains: ['island-villas.example'] };
const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
const codes = (name: string) =>
  validateSite(load(name), OPTIONS).map((issue) => `${issue.severity}:${issue.code}@${issue.path.join('.')}`);

describe('fixture sites', () => {
  it.each(['salon-gustavia', 'cafe-saint-jean', 'hardware-store-lorient', 'villa-agency'])(
    '%s validates with no issue at all',
    (name) => {
      expect(SiteSpecSchema.safeParse(load(name)).success).toBe(true);
      expect(validateSite(load(name), OPTIONS)).toEqual([]);
    },
  );

  it.each([
    ['broken-locale-missing', ['error:locale_missing@pages.0.blocks.0.props.title.en']],
    ['broken-contrast', ['error:contrast_low@theme.palette.text']],
    [
      'broken-references',
      [
        'error:unknown_page@navigation.items.3.pageId',
        'error:unknown_asset@pages.0.blocks.0.props.imageAssetId',
      ],
    ],
    [
      'broken-external-url',
      [
        'error:asset_host@assets.1.url',
        'error:external_url@contact.bookingUrl.value',
        'error:external_url@pages.0.blocks.4.props.title.en',
      ],
    ],
    ['broken-testimonial', ['error:schema@pages.0.blocks.3.props.items.0.factId']],
    [
      'broken-hero',
      [
        'error:hero_multiple@pages.1.blocks.2',
        'warning:hero_not_first@pages.1.blocks.1',
        'error:hero_missing@pages.2.blocks',
      ],
    ],
    [
      'broken-requirements',
      [
        'error:cta_unresolved@pages.0.blocks.4.props.cta',
        'warning:block_requirement@layout.footer.showHours',
        'error:block_requirement@pages.1.blocks.1',
        'error:block_requirement@pages.2.blocks.2',
      ],
    ],
    [
      'broken-rich-text',
      [
        'error:external_url@pages.1.blocks.2.props.body.fr',
        'error:rich_text@pages.1.blocks.2.props.body.fr',
        'error:rich_text@pages.1.blocks.2.props.body.fr',
      ],
    ],
  ])('%s fails with exactly its issues', (name, expected) => {
    expect([...codes(name)].sort()).toEqual([...expected].sort());
    expect(hasErrors(validateSite(load(name), OPTIONS))).toBe(true);
  });

  it('validates a typical site in under 5 ms', () => {
    const spec = load('salon-gustavia');
    validateSite(spec, OPTIONS); // warm-up
    // The best of 30 runs: the code's cost, not the machine's load (CI runs many suites at once).
    const times = Array.from({ length: 30 }, () => {
      const started = performance.now();
      validateSite(spec, OPTIONS);
      return performance.now() - started;
    });
    expect(Math.min(...times)).toBeLessThan(5);
  });

  it('has a test for every fixture file', () => {
    const files = readdirSync(new URL('../fixtures', import.meta.url)).map((file) =>
      file.replace(/\.json$/, ''),
    );
    expect(files.sort()).toEqual(
      [
        'salon-gustavia',
        'cafe-saint-jean',
        'hardware-store-lorient',
        'villa-agency',
        'broken-locale-missing',
        'broken-contrast',
        'broken-references',
        'broken-external-url',
        'broken-testimonial',
        'broken-hero',
        'broken-requirements',
        'broken-rich-text',
      ].sort(),
    );
  });
});
