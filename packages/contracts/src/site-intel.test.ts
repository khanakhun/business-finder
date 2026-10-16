import { describe, expect, it } from 'vitest';
import { NO_SOLICITATION_PHRASES, SiteIntelRequestSchema } from './site-intel.ts';

describe('SiteIntelRequestSchema', () => {
  it('applies the crawl defaults', () => {
    expect(SiteIntelRequestSchema.parse({ url: 'https://example.com', artifactPrefix: 'b/1/site' })).toEqual({
      url: 'https://example.com',
      artifactPrefix: 'b/1/site',
      maxPages: 6,
      localesHint: [],
      screenshots: { desktop: true, mobile: true, fullPage: false },
      timeoutSeconds: 60,
    });
  });

  it.each(['../etc', '/abs', 'trailing/', 'a//b', 'Upper', 'a b'])(
    'rejects the prefix %j',
    (artifactPrefix) => {
      expect(SiteIntelRequestSchema.safeParse({ url: 'https://example.com', artifactPrefix }).success).toBe(
        false,
      );
    },
  );

  it('bounds pages and timeouts', () => {
    const base = { url: 'https://example.com', artifactPrefix: 'p' };
    expect(SiteIntelRequestSchema.safeParse({ ...base, maxPages: 13 }).success).toBe(false);
    expect(SiteIntelRequestSchema.safeParse({ ...base, timeoutSeconds: 5 }).success).toBe(false);
  });
});

describe('NO_SOLICITATION_PHRASES', () => {
  it('covers French, Dutch and English in lower case', () => {
    expect(Object.keys(NO_SOLICITATION_PHRASES).sort()).toEqual(['en', 'fr', 'nl']);
    for (const phrases of Object.values(NO_SOLICITATION_PHRASES))
      for (const phrase of phrases) expect(phrase).toBe(phrase.toLowerCase());
  });
});
