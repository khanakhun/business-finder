import { describe, expect, it } from 'vitest';
import { DHASH_HEIGHT, DHASH_WIDTH, dhash, hamming, isNearDuplicate, laplacianVariance } from './dhash.ts';
import { isProviderPhoto, judgeOwnerImage } from './image-policy.ts';
import { paletteFit, type RankableAsset, rankCandidates } from './ranking.ts';

const GOOD = {
  quality: 4,
  heroSuitability: 4,
  containsText: false,
  containsPeople: false,
  identifiablePeople: false,
} as const;

const photo = (overrides: Partial<RankableAsset> = {}): RankableAsset => ({
  id: 'p',
  kind: 'photo',
  source: 'owner_site',
  width: 2000,
  height: 1200,
  analysis: {
    quality: 4,
    heroSuitability: 4,
    containsText: false,
    containsPeople: false,
    identifiablePeople: false,
  },
  dominantColors: null,
  ...overrides,
});

describe('image policy', () => {
  it.each([
    'https://lh3.googleusercontent.com/p/AF1Q=w800',
    'https://fastly.4sqi.net/img/general/600x600/x.jpg',
    'https://media-cdn.tripadvisor.com/media/photo-o/x.jpg',
    'https://s3-media0.fl.yelpcdn.com/bphoto/x/o.jpg',
    'https://scontent.cdninstagram.com/x.jpg',
    'not a url',
  ])('never takes a provider photo: %s', (url) => {
    expect(isProviderPhoto(url)).toBe(true);
    expect(judgeOwnerImage({ url, width: 1600, height: 1200, sharpness: 500 }, 'photo')).toEqual({
      ok: false,
      reason: 'provider_photo',
    });
  });

  it('keeps real photos of the business’s site and drops pixels, sprites, icons, thumbnails and blurry ones', () => {
    const url = 'https://salon.example/images/terrasse.jpg';
    expect(isProviderPhoto(url)).toBe(false);
    expect(judgeOwnerImage({ url, width: 1600, height: 1200, sharpness: 500 }, 'photo')).toEqual({
      ok: true,
    });
    const reason = (image: Parameters<typeof judgeOwnerImage>[0], kind: 'photo' | 'logo' = 'photo') => {
      const verdict = judgeOwnerImage(image, kind);
      return verdict.ok ? 'ok' : verdict.reason;
    };
    expect(reason({ url, width: 1, height: 1, sharpness: null })).toBe('tracking_pixel');
    expect(reason({ url, width: 3000, height: 400, sharpness: 500 })).toBe('sprite');
    expect(
      reason({ url: 'https://salon.example/icons/x.png', width: 800, height: 800, sharpness: 500 }),
    ).toBe('icon');
    expect(reason({ url, width: 800, height: 500, sharpness: 500 })).toBe('too_small');
    expect(reason({ url, width: 1600, height: 1200, sharpness: 10 })).toBe('blurry');
    // Logos are small by nature, but not icons.
    expect(reason({ url, width: 300, height: 90, sharpness: null }, 'logo')).toBe('ok');
    expect(reason({ url, width: 32, height: 32, sharpness: null }, 'logo')).toBe('too_small');
  });
});

describe('near-duplicates and sharpness', () => {
  const gradient = (shift: number) =>
    Uint8Array.from({ length: DHASH_WIDTH * DHASH_HEIGHT }, (_, i) => ((i * 37 + shift) * 13) % 256);

  it('hashes 9 × 8 grey pixels into 64 bits and measures distances', () => {
    const a = dhash(gradient(0));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hamming(a, a)).toBe(0);
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hamming(a, 'short')).toBe(64);
    expect(isNearDuplicate(a, ['ffffffffffffffff', a])).toBe(true);
    expect(isNearDuplicate('0000000000000000', ['ffffffffffffffff'])).toBe(false);
    expect(() => dhash(new Uint8Array(10))).toThrow();
  });

  it('finds a sharp checkerboard sharper than a flat image', () => {
    const size = 16;
    const flat = new Uint8Array(size * size).fill(128);
    const checker = Uint8Array.from({ length: size * size }, (_, i) =>
      (Math.floor(i / size) + (i % size)) % 2 ? 255 : 0,
    );
    expect(laplacianVariance(flat, size, size)).toBe(0);
    expect(laplacianVariance(checker, size, size)).toBeGreaterThan(10_000);
    expect(laplacianVariance(flat, 2, 2)).toBe(0);
  });
});

describe('ranking', () => {
  it('prefers the business’s own good photo for the gallery and explains why', () => {
    const [best, second] = rankCandidates(
      [photo({ id: 'stock', source: 'stock' }), photo({ id: 'own', source: 'owner_site' })],
      { role: 'gallery' },
    );
    expect(best?.asset.id).toBe('own');
    expect(best?.reasons).toContain("+15 the business's own photo");
    expect(second?.asset.id).toBe('stock');
  });

  it('lets stock win the hero over a weak own photo, and prefers wide landscapes', () => {
    const ranked = rankCandidates(
      [
        photo({ id: 'weak-own', analysis: { ...GOOD, quality: 2, heroSuitability: 2 } }),
        photo({ id: 'stock', source: 'stock' }),
        photo({ id: 'portrait', source: 'stock', width: 1000, height: 1500 }),
      ],
      { role: 'hero' },
    );
    expect(ranked.map((entry) => entry.asset.id)).toEqual(['stock', 'portrait', 'weak-own']);
  });

  it('never offers an AI image showing people, and ranks logos for logo roles only', () => {
    const ai = photo({ id: 'ai', source: 'ai', analysis: { ...GOOD, containsPeople: true } });
    expect(rankCandidates([ai], { role: 'gallery' })).toEqual([]);
    const logo = photo({ id: 'logo', kind: 'logo', width: 512, height: 512, analysis: null });
    const wordmark = photo({ id: 'wm', kind: 'logo', source: 'wordmark', width: 1200, height: 400 });
    expect(rankCandidates([photo(), logo, wordmark], { role: 'favicon' }).map((r) => r.asset.id)).toEqual([
      'logo',
      'wm',
    ]);
    expect(rankCandidates([logo], { role: 'hero' })).toEqual([]);
  });

  it('measures palette fit (ΔE) and neutral-scores unanalysed photos', () => {
    expect(paletteFit(['#7a5c3e'], ['#7a5c3e'])).toBe(1);
    expect(paletteFit(['#000000'], ['#ffffff'])).toBe(0);
    expect(paletteFit([], ['#ffffff'])).toBeNull();
    expect(paletteFit(['nope'], ['#ffffff'])).toBeNull();
    const [ranked] = rankCandidates([photo({ analysis: null, dominantColors: ['#7a5c3e'] })], {
      role: 'about',
      palette: ['#7a5c3e'],
    });
    expect(ranked?.reasons).toContain('+20 not analysed yet (neutral quality)');
    expect(ranked?.reasons).toContain('+10 colours close to the palette');
  });
});

describe('licensing profiles, the AI prompt policy and stock queries', () => {
  it('hotlinks Unsplash only, credits stock photographers and keeps owner images preview-only', async () => {
    const { attributionFor, HOTLINK_HOSTS, LICENSING_PROFILES } = await import('./licensing-profile.ts');
    expect(HOTLINK_HOSTS).toEqual(['images.unsplash.com']);
    expect(LICENSING_PROFILES.unsplash.downloadTrackingRequired).toBe(true);
    expect(attributionFor(LICENSING_PROFILES.unsplash, 'Ana Ruiz')).toBe('Photo by Ana Ruiz on Unsplash');
    expect(attributionFor(LICENSING_PROFILES.pexels, ' ')).toBe('Photo by unknown on Pexels');
    expect(attributionFor(LICENSING_PROFILES.ai, 'x')).toBeUndefined();
    expect(LICENSING_PROFILES.owner_site.restrictions).toEqual(['preview_only']);
  });

  it.each([
    ['a smiling chef in the kitchen', false],
    ['portrait of a woman', false],
    ['une femme qui sourit', false],
    ['the salon logo on a wall', false],
    ['our salon interior', false],
    ['texte « bienvenue » sur un mur', false],
    ['see https://evil.example', false],
    ['calm turquoise sea with palm shadows', true],
    ['linen texture in warm beige', true],
  ])('judges the prompt %s', async (prompt, ok) => {
    const { judgeImagePrompt, violatesImagePolicy } = await import('./image-prompt-policy.ts');
    expect(judgeImagePrompt(prompt).ok).toBe(ok);
    expect(violatesImagePolicy({ containsPeople: false, containsText: true })).toBe(true);
  });

  it('builds scene queries per category with the style, falling back to generic scenes', async () => {
    const { normalizeQuery, stockQueries } = await import('./stock-queries.ts');
    expect(stockQueries('hair_salon', 'luxe')[0]).toBe('elegant hair salon interior');
    expect(stockQueries('unknown_kind', undefined)).toContain('caribbean coastline');
    expect(normalizeQuery('  Hair   SALON ')).toBe('hair salon');
  });
});
