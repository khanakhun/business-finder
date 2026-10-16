import { describe, expect, it } from 'vitest';
import {
  BBoxSchema,
  COUNTRY_CODES,
  CountryCodeSchema,
  LatLngSchema,
  MultiPolygonSchema,
  PolygonSchema,
} from './geo.ts';

const ring = [
  [-62.88, 17.87],
  [-62.79, 17.87],
  [-62.79, 17.93],
  [-62.88, 17.87],
];

describe('LatLngSchema', () => {
  it.each([
    [{ lat: 17.9, lng: -62.85 }, true],
    [{ lat: -90, lng: 180 }, true],
    [{ lat: 91, lng: 0 }, false],
    [{ lat: 0, lng: -181 }, false],
  ])('%j → %s', (value, valid) => {
    expect(LatLngSchema.safeParse(value).success).toBe(valid);
  });
});

describe('BBoxSchema', () => {
  it('accepts normal and antimeridian-crossing boxes', () => {
    expect(BBoxSchema.safeParse({ west: -63, south: 17, east: -62, north: 18 }).success).toBe(true);
    expect(BBoxSchema.safeParse({ west: 170, south: -20, east: -170, north: -10 }).success).toBe(true);
  });

  it('rejects south above north', () => {
    expect(BBoxSchema.safeParse({ west: 0, south: 10, east: 1, north: 5 }).success).toBe(false);
  });
});

describe('GeoJSON polygons', () => {
  it('accept closed rings', () => {
    expect(PolygonSchema.safeParse({ type: 'Polygon', coordinates: [ring] }).success).toBe(true);
    expect(MultiPolygonSchema.safeParse({ type: 'MultiPolygon', coordinates: [[ring]] }).success).toBe(true);
  });

  it('reject open rings', () => {
    const open = [...ring.slice(0, 3), [-62.8, 17.9]];
    const result = PolygonSchema.safeParse({ type: 'Polygon', coordinates: [open] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/closed/);
  });

  it('reject rings with fewer than 4 positions and out-of-range positions', () => {
    expect(PolygonSchema.safeParse({ type: 'Polygon', coordinates: [ring.slice(1)] }).success).toBe(false);
    expect(
      PolygonSchema.safeParse({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0, 95],
            [1, 1],
            [0, 0],
          ],
        ],
      }).success,
    ).toBe(false);
    expect(MultiPolygonSchema.safeParse({ type: 'MultiPolygon', coordinates: [] }).success).toBe(false);
  });
});

describe('CountryCodeSchema', () => {
  it('knows all 249 assigned ISO 3166-1 alpha-2 codes, including BL and MF', () => {
    expect(COUNTRY_CODES.size).toBe(249);
    for (const code of ['BL', 'MF', 'FR', 'GP', 'MQ', 'US', 'SX'])
      expect(CountryCodeSchema.safeParse(code).success).toBe(true);
  });

  it.each(['bl', 'XX', 'EU', 'FRA', ''])('rejects %j', (code) => {
    expect(CountryCodeSchema.safeParse(code).success).toBe(false);
  });
});
