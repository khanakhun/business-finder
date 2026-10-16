import type { SiteAsset } from '@bf/contracts';
import { applyAll, type SiteSpec, SiteSpecSchema } from '@bf/site-schema';
import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import {
  altFor,
  isRestricted,
  isUsable,
  mintAssetId,
  orientationOf,
  specAssetFor,
  toSpecAsset,
} from './spec-asset.ts';

const spec = SiteSpecSchema.parse(salon) as SiteSpec;

const library = (overrides: Partial<SiteAsset> = {}): SiteAsset => ({
  id: '0199a0b0-0000-7000-8000-000000000001',
  siteId: '0199a0b0-0000-7000-8000-000000000002' as SiteAsset['siteId'],
  status: 'ready',
  mime: 'image/jpeg',
  width: 1600,
  height: 1000,
  bytes: 120_000,
  publicUrl: 'https://assets.sites.test/sites/s/a/1200.webp',
  variants: [],
  license: 'uploaded',
  licenseDetails: { author: 'Studio Test' },
  alt: { fr: 'La terrasse au coucher du soleil', en: 'The terrace at sunset', de: 'Die Terrasse' },
  dominantColors: ['#112233', '#445566', '#778899', '#aabbcc', '#ddeeff', '#000000'],
  kind: 'image',
  source: 'upload',
  restrictions: [],
  focalPoint: null,
  analysis: null,
  ownership: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

describe('library images as site images', () => {
  it('mints a 6–32 character id the site does not use yet', () => {
    const id = mintAssetId(new Set());
    expect(id).toMatch(/^img_[a-z0-9]{10}$/);
    // A taken id is drawn again.
    let call = 0;
    const draws = [new Uint8Array(10).fill(0), new Uint8Array(10).fill(1)];
    const second = mintAssetId(new Set(['img_aaaaaaaaaa']), (bytes) => {
      bytes.set(draws[call++] ?? new Uint8Array(10));
      return bytes;
    });
    expect(second).toBe('img_bbbbbbbbbb');
  });

  it('maps a processed image: public URL, size, licence, credit, the site’s alt texts, at most 5 colours', () => {
    const asset = toSpecAsset(library(), spec, { focalPoint: { x: 0.2, y: 0.8 } });
    expect(asset).toMatchObject({
      kind: 'image',
      url: 'https://assets.sites.test/sites/s/a/1200.webp',
      width: 1600,
      height: 1000,
      license: 'uploaded',
      attribution: 'Studio Test',
      alt: { fr: 'La terrasse au coucher du soleil', en: 'The terrace at sunset' },
      focalPoint: { x: 0.2, y: 0.8 },
    });
    expect(asset?.dominantColors).toHaveLength(5);
    expect(spec.assets.some((existing) => existing.id === asset?.id)).toBe(false);
    // The site accepts it.
    if (!asset) throw new Error('expected an asset');
    const next = applyAll(spec, [{ op: 'addAsset', asset }]).spec;
    expect(next.assets.at(-1)?.id).toBe(asset?.id);
  });

  it('refuses images that are not ready, restricted, or without alt text in the site’s languages', () => {
    expect(toSpecAsset(library({ status: 'processing', publicUrl: null }), spec)).toBeUndefined();
    expect(toSpecAsset(library({ licenseDetails: { provider: 'Google' } }), spec)).toBeUndefined();
    expect(toSpecAsset(library({ alt: { de: 'Nur Deutsch' } }), spec)).toBeUndefined();
    // Alt texts given in the picker replace the library's.
    expect(toSpecAsset(library({ alt: null }), spec, { alt: { fr: 'Le salon' } })?.alt).toEqual({
      fr: 'Le salon',
    });
  });

  it('tells restricted, usable and oriented images apart, and finds one the site already has', () => {
    expect(isRestricted(library({ licenseDetails: { provider: ' TripAdvisor ' } }))).toBe(true);
    expect(isRestricted(library({ licenseDetails: { provider: 'unsplash' } }))).toBe(false);
    expect(isUsable(library({ status: 'failed' }))).toBe(false);
    expect(orientationOf(1600, 1000)).toBe('landscape');
    expect(orientationOf(800, 1200)).toBe('portrait');
    expect(orientationOf(1000, 1040)).toBe('square');
    expect(altFor(library(), ['fr'])).toEqual({ fr: 'La terrasse au coucher du soleil' });
    const [existing] = spec.assets;
    if (!existing) throw new Error('the fixture has images');
    expect(specAssetFor(spec, library({ publicUrl: existing.url }))?.id).toBe(existing.id);
    expect(specAssetFor(spec, library())).toBeUndefined();
  });
});
