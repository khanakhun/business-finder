import type { MultiPolygon } from '@bf/contracts';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { distance } from '@turf/distance';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeAreaName } from './area-names.ts';
import { areaKm2, asMultiPolygon, bboxOf, centroidOf, toMultiPolygon } from './geometry.ts';
import { DEFAULT_NEAR_RADIUS_M, parseLocationPattern } from './location-patterns.ts';
import { subdivide, TilingError, tileAsBBoxes, tileAsCircles } from './tiling.ts';

/** A rough, fake Saint-Barth-sized polygon (~ 9 km × 4 km). */
const ISLAND: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-62.88, 17.88],
        [-62.79, 17.88],
        [-62.79, 17.93],
        [-62.84, 17.92],
        [-62.88, 17.91],
        [-62.88, 17.88],
      ],
    ],
  ],
};
/** An urban-postcode-sized square (~ 1 km). */
const PC4: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [4.89, 52.37],
        [4.905, 52.37],
        [4.905, 52.379],
        [4.89, 52.379],
        [4.89, 52.37],
      ],
    ],
  ],
};

const rect = (west: number, south: number, east: number, north: number): MultiPolygon => ({
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  ],
});

describe('parseLocationPattern', () => {
  it.each([
    ['1012 AB', { kind: 'nl_postcode', pc4: '1012', full: '1012 AB' }],
    ['1012', { kind: 'nl_postcode', pc4: '1012', full: null }],
    ['33139', { kind: 'us_zip', zip: '33139' }],
    ['33139-1234', { kind: 'us_zip', zip: '33139' }],
    ['within 5 km of Lorient', { kind: 'radius', radiusM: 5000, place: 'Lorient' }],
    ['within 3 miles of Saint-Jean', { kind: 'radius', radiusM: 4828, place: 'Saint-Jean' }],
    ['dans un rayon de 2 km autour de Gustavia', { kind: 'radius', radiusM: 2000, place: 'Gustavia' }],
    ['à 1,5 km de Flamands', { kind: 'radius', radiusM: 1500, place: 'Flamands' }],
    ['500 m around Corossol', { kind: 'radius', radiusM: 500, place: 'Corossol' }],
    ['près de Lorient', { kind: 'radius', radiusM: DEFAULT_NEAR_RADIUS_M, place: 'Lorient' }],
    ['near Gustavia', { kind: 'radius', radiusM: DEFAULT_NEAR_RADIUS_M, place: 'Gustavia' }],
    ['17.8962, -62.8498', { kind: 'latlng', lat: 17.8962, lng: -62.8498, radiusM: null }],
    ['within 2 km of 17.9, -62.85', { kind: 'latlng', lat: 17.9, lng: -62.85, radiusM: 2000 }],
  ])('%s', (input, expected) => {
    expect(parseLocationPattern(input)).toEqual(expected);
  });

  it.each([
    ['97133', 'BL', null],
    ['75001', 'FR', null],
    ['2024', 'FR', null],
    ['1012', 'NL', { kind: 'nl_postcode', pc4: '1012', full: null }],
    ['1012 AB', 'BL', { kind: 'nl_postcode', pc4: '1012', full: '1012 AB' }],
    ['33139', 'US', { kind: 'us_zip', zip: '33139' }],
    ['33139-1234', 'BL', { kind: 'us_zip', zip: '33139' }],
  ])('reads %s with hint %s by the country', (input, hint, expected) => {
    expect(parseLocationPattern(input, hint)).toEqual(expected);
  });

  it.each([
    'Gustavia',
    'St Barth',
    '0123',
    '1234567',
    '95.0, 10',
    'within km of X',
    'within 5 km of 99, 999',
  ])('ignores %s', (input) => {
    expect(parseLocationPattern(input)).toBeNull();
  });
});

describe('normalizeAreaName', () => {
  it('folds accents, punctuation and abbreviations', () => {
    expect(normalizeAreaName('Saint-Barthélemy')).toBe('saint barthelemy');
    expect(normalizeAreaName('ST. BARTH')).toBe('saint barth');
    expect(normalizeAreaName("Anse d'Hôtel")).toBe('anse d hotel');
    expect(normalizeAreaName('Ste-Anne')).toBe('sainte anne');
  });
});

describe('geometry', () => {
  it('computes bbox, area, centroid and converts circles and polygons', () => {
    expect(bboxOf(ISLAND)).toEqual({ west: -62.88, south: 17.88, east: -62.79, north: 17.93 });
    expect(areaKm2(ISLAND)).toBeGreaterThan(20);
    expect(centroidOf(ISLAND).lat).toBeCloseTo(17.9, 1);
    const circle = asMultiPolygon({ type: 'Circle', center: { lat: 17.9, lng: -62.85 }, radiusM: 1000 });
    const box = bboxOf(circle);
    expect(box.north - box.south).toBeCloseTo(0.018, 2);
    expect(toMultiPolygon({ type: 'Polygon', coordinates: PC4.coordinates[0] as never }).type).toBe(
      'MultiPolygon',
    );
  });
});

describe('tiling', () => {
  const pointsInside = (area: MultiPolygon) => {
    const box = bboxOf(area);
    return fc
      .tuple(
        fc.double({ min: box.west, max: box.east, noNaN: true }),
        fc.double({ min: box.south, max: box.north, noNaN: true }),
      )
      .filter(([lng, lat]) => booleanPointInPolygon([lng, lat], area as never));
  };

  it('bbox tiles stay inside the area bbox and cover every point of the area', () => {
    const tiles = tileAsBBoxes(ISLAND, 2);
    const box = bboxOf(ISLAND);
    expect(tiles.length).toBeGreaterThan(5);
    for (const tile of tiles) {
      expect(tile.bbox.west).toBeGreaterThanOrEqual(box.west);
      expect(tile.bbox.east).toBeLessThanOrEqual(box.east + 1e-9);
      expect(tile.bbox.north).toBeLessThanOrEqual(box.north + 1e-9);
    }
    fc.assert(
      fc.property(pointsInside(ISLAND), ([lng, lat]) => {
        expect(
          tiles.some(
            (t) => lng >= t.bbox.west && lng <= t.bbox.east && lat >= t.bbox.south && lat <= t.bbox.north,
          ),
        ).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('circles cover every point of the area (island and urban postcode)', () => {
    for (const [area, radius] of [
      [ISLAND, 1500],
      [PC4, 300],
    ] as const) {
      const circles = tileAsCircles(area, radius);
      expect(circles.length).toBeGreaterThan(1);
      fc.assert(
        fc.property(pointsInside(area), ([lng, lat]) => {
          const near = circles.some(
            (c) => distance([lng, lat], [c.center.lng, c.center.lat], { units: 'meters' }) <= radius * 1.001,
          );
          expect(near).toBe(true);
        }),
        { numRuns: 200 },
      );
    }
  });

  it('subdivides tiles in four, clipped to the area', () => {
    const box = bboxOf(ISLAND);
    expect(subdivide(box)).toHaveLength(4);
    const clipped = subdivide(box, ISLAND);
    expect(clipped.length).toBeGreaterThanOrEqual(3);
    expect(() => tileAsBBoxes(ISLAND, 0)).toThrow(TilingError);
    expect(() => tileAsCircles(ISLAND, -1)).toThrow(TilingError);
  });

  it('refuses tilings that would explode (tiny cells, antimeridian-crossing areas)', () => {
    expect(() => tileAsBBoxes(ISLAND, 0.01)).toThrow(TilingError);
    expect(() => tileAsCircles(rect(-10, 40, 10, 60), 100)).toThrow(/tiles/);
    // A Fiji-like outline spanning ±180: Turf's bbox covers the globe.
    const fiji: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        rect(177, -19, 180, -16).coordinates[0],
        rect(-180, -19, -179, -16).coordinates[0],
      ] as never,
    };
    expect(() => tileAsBBoxes(fiji, 10)).toThrow(/antimeridian/);
  });

  it('circles cover a tall area too (spacing follows latitude)', () => {
    const tall = rect(10, 30, 11, 60);
    const radius = 30_000;
    const circles = tileAsCircles(tall, radius);
    fc.assert(
      fc.property(pointsInside(tall), ([lng, lat]) => {
        const near = circles.some(
          (c) => distance([lng, lat], [c.center.lng, c.center.lat], { units: 'meters' }) <= radius * 1.001,
        );
        expect(near).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
