import { describe, expect, it } from 'vitest';
import {
  extendedExpiry,
  PREVIEW_MAX_DAYS,
  previewExpiry,
  previewHostname,
  siteStatus,
} from './publication-policy.ts';

const now = new Date('2026-10-16T12:00:00.000Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

describe('publication policy', () => {
  it('derives the site status from its active publications', () => {
    expect(siteStatus('draft', [])).toBe('draft');
    expect(siteStatus('draft', ['preview'])).toBe('preview');
    expect(siteStatus('preview', ['preview', 'live'])).toBe('live');
    expect(siteStatus('preview', [])).toBe('draft');
    expect(siteStatus('archived', ['preview'])).toBe('archived');
  });

  it('names the preview host and its expiry', () => {
    expect(previewHostname('salon-gustavia', 'Sites.Example.com')).toBe('salon-gustavia.sites.example.com');
    expect(previewExpiry(now, 30)).toEqual(days(30));
  });

  it('extends from the current expiry, from now once it passed, never beyond 90 days ahead', () => {
    expect(extendedExpiry(now, days(10), 7)).toEqual(days(17));
    expect(extendedExpiry(now, days(-3), 7)).toEqual(days(7));
    expect(extendedExpiry(now, null, 7)).toEqual(days(7));
    expect(extendedExpiry(now, days(80), 30)).toEqual(days(PREVIEW_MAX_DAYS));
  });
});
