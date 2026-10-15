import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { distanceMeters, geohashEncode, geohashWithNeighbours } from './geohash.ts';
import { jaroWinkler, nameSimilarity, significantTokens, tokenSetRatio } from './string-similarity.ts';

describe('jaroWinkler', () => {
  it('matches known values', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.813, 3);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
    expect(jaroWinkler('', '')).toBe(1);
    expect(jaroWinkler('a', '')).toBe(0);
  });

  it('is symmetric and bounded', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b) => {
        const s = jaroWinkler(a, b);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(jaroWinkler(b, a)).toBeCloseTo(s, 10);
      }),
    );
  });
});

describe('nameSimilarity', () => {
  it.each([
    ['chez joe', 'chez jo s', 0.85],
    ['le tamarin', 'tamarin restaurant', 0.99],
    ['la cabane du pecheur', 'cabane pecheur', 0.95],
    ['eden rock', 'eden rock hotel', 0.99],
    ['quincaillerie du port', 'quincaillerie port', 0.95],
  ])('%s ≈ %s', (a, b, min) => {
    expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(min);
  });

  it.each([
    ['le tamarin', 'le ti st barth'],
    ['pharmacie centrale', 'boulangerie du port'],
    ['villa marie', 'villa rose'],
  ])('%s ≠ %s', (a, b) => {
    expect(nameSimilarity(a, b)).toBeLessThan(0.8);
  });

  it('keeps names made only of generic words', () => {
    expect(significantTokens('le bar')).toEqual(['le', 'bar']);
    expect(tokenSetRatio([], ['a'])).toBe(0);
    expect(nameSimilarity('', 'x')).toBe(0);
  });
});

describe('geohash', () => {
  it('encodes known points and lists neighbours', () => {
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
    expect(geohashEncode(17.8962, -62.8498, 6)).toHaveLength(6);
    const cells = geohashWithNeighbours(17.8962, -62.8498);
    expect(cells).toHaveLength(9);
    expect(cells).toContain(geohashEncode(17.8962, -62.8498));
  });

  it('puts points within 75 m in a shared neighbourhood', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -60, max: 60, noNaN: true }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -0.0006, max: 0.0006, noNaN: true }),
        fc.double({ min: -0.0006, max: 0.0006, noNaN: true }),
        (lat, lng, dLat, dLng) => {
          const a = geohashWithNeighbours(lat, lng);
          const b = geohashEncode(lat + dLat, lng + dLng);
          expect(a).toContain(b);
        },
      ),
    );
  });

  it('measures distances', () => {
    expect(distanceMeters({ lat: 17.8962, lng: -62.8498 }, { lat: 17.8962, lng: -62.8498 })).toBe(0);
    expect(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111_195, -2);
  });
});
