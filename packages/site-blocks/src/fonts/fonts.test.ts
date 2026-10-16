import { FONT_PAIRS, SITE_LOCALES } from '@bf/site-schema';
import { describe, expect, it } from 'vitest';

import { UI_STRINGS } from '../i18n/strings.ts';
import { embedOrigins, isEmbeddable } from '../renderer/embeds.ts';
import { fixture } from '../test-utils.tsx';
import { FONT_FAMILIES, fontStacks, pairPreloads } from './families.ts';
import { fontFaces } from './font-face.ts';

describe('fonts', () => {
  it('self-hosts every family of every curated pair', () => {
    const hosted = new Set(FONT_FAMILIES.map((files) => files.family));
    for (const pair of FONT_PAIRS) {
      expect(hosted).toContain(pair.heading.family);
      expect(hosted).toContain(pair.body.family);
    }
  });

  it('preloads a pair’s upright latin files, once when both fonts are one family', () => {
    expect(pairPreloads('playfair-inter')).toEqual([
      'playfair-display-latin-wght-normal.woff2',
      'inter-latin-wght-normal.woff2',
    ]);
    expect(pairPreloads('manrope-manrope')).toEqual(['manrope-latin-wght-normal.woff2']);
    expect(pairPreloads('dmserif-dmsans')[0]).toBe('dm-serif-display-latin-400-normal.woff2');
    expect(fontStacks('josefin-lato').body).toMatch(/^"Lato", system-ui/);
  });

  it('keeps only the latin and latin-ext faces of a package stylesheet, renamed and pointed at our files', () => {
    const css = ['cyrillic', 'latin-ext', 'latin']
      .map(
        (subset) =>
          `/* inter-${subset}-wght-normal */\n@font-face {\n  font-family: 'Inter Variable';\n  font-style: normal;\n  font-display: swap;\n  font-weight: 100 900;\n  src: url(./files/inter-${subset}-wght-normal.woff2) format('woff2-variations');\n  unicode-range: U+0000-00FF;\n}\n`,
      )
      .join('\n');
    const inter = FONT_FAMILIES.find((files) => files.family === 'Inter');
    if (!inter) throw new Error('no Inter');
    const { rules, urls } = fontFaces(css, inter);
    expect(urls).toEqual(['inter-latin-ext-wght-normal.woff2', 'inter-latin-wght-normal.woff2']);
    expect(rules[1]).toBe(
      '@font-face{font-family:"Inter";src:url(./fonts/inter-latin-wght-normal.woff2) format("woff2");font-style: normal;font-display: swap;font-weight: 100 900;unicode-range: U+0000-00FF}',
    );
  });
});

describe('interface words', () => {
  it('exist in every site language and name every language', () => {
    for (const locale of SITE_LOCALES) {
      expect(UI_STRINGS[locale].skipToContent).not.toBe('');
      expect(Object.keys(UI_STRINGS[locale].languageNames).sort()).toEqual([...SITE_LOCALES].sort());
    }
    expect(UI_STRINGS.fr.form.send).toBe('Envoyer');
    expect(UI_STRINGS.de.hours).toBe('Öffnungszeiten');
  });
});

describe('booking embeds', () => {
  it('frames only allowlisted providers, and declares their origin for the CSP', () => {
    expect(isEmbeddable('https://calendly.com/salon')).toBe(true);
    expect(isEmbeddable('https://evil.example/calendly.com')).toBe(false);
    const villa = fixture('villa-agency');
    expect(embedOrigins(villa)).toEqual([]);
    const embedded = {
      ...villa,
      contact: {
        ...villa.contact,
        bookingUrl: { value: 'https://calendly.com/villas', factId: 'booking.main' },
      },
    };
    expect(embedOrigins(embedded)).toEqual(['https://calendly.com']);
  });
});
