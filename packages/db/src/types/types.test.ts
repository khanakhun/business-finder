import { describe, expect, it } from 'vitest';
import { ColumnValueError } from './errors.ts';
import { assertLatLng } from './geography.ts';
import { assertLtree } from './text.ts';
import { fromPgVector, toPgVector, vector } from './vector.ts';
import { parseWkbHex } from './wkb.ts';

/** Builds little-endian EWKB like PostGIS emits (SRID flag set on the outer geometry only). */
function ewkb(parts: Array<['u8' | 'u32' | 'f64', number]>): string {
  const size = parts.reduce((n, [t]) => n + (t === 'u8' ? 1 : t === 'u32' ? 4 : 8), 0);
  const buf = Buffer.alloc(size);
  let o = 0;
  for (const [t, v] of parts) {
    if (t === 'u8') o = buf.writeUInt8(v, o);
    else if (t === 'u32') o = buf.writeUInt32LE(v, o);
    else o = buf.writeDoubleLE(v, o);
  }
  return buf.toString('hex');
}

const SRID_FLAG = 0x20000000;
const ring = (pts: Array<[number, number]>) =>
  [
    ['u32', pts.length],
    ...pts.flatMap(([x, y]) => [
      ['f64', x],
      ['f64', y],
    ]),
  ] as Array<['u32' | 'f64', number]>;

describe('parseWkbHex', () => {
  it('reads an EWKB point as [lng, lat]', () => {
    // Gustavia, Saint-Barthélemy: lat 17.8962, lng -62.8498
    const hex = ewkb([
      ['u8', 1],
      ['u32', 1 | SRID_FLAG],
      ['u32', 4326],
      ['f64', -62.8498],
      ['f64', 17.8962],
    ]);
    expect(parseWkbHex(hex)).toEqual({ type: 'Point', coordinates: [-62.8498, 17.8962] });
  });

  it('reads big-endian WKB', () => {
    const buf = Buffer.alloc(21);
    buf.writeUInt8(0, 0);
    buf.writeUInt32BE(1, 1);
    buf.writeDoubleBE(2.35, 5);
    buf.writeDoubleBE(48.85, 13);
    expect(parseWkbHex(buf.toString('hex'))).toEqual({ type: 'Point', coordinates: [2.35, 48.85] });
  });

  it('drops Z and M ordinates (EWKB flags and ISO codes)', () => {
    const ewkbZ = ewkb([
      ['u8', 1],
      ['u32', 0x80000001],
      ['f64', 1],
      ['f64', 2],
      ['f64', 99],
    ]);
    expect(parseWkbHex(ewkbZ).coordinates).toEqual([1, 2]);
    const isoZM = ewkb([
      ['u8', 1],
      ['u32', 3001],
      ['f64', 1],
      ['f64', 2],
      ['f64', 3],
      ['f64', 4],
    ]);
    expect(parseWkbHex(isoZM).coordinates).toEqual([1, 2]);
  });

  it('reads polygons and multipolygons', () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    const polygon = ewkb([['u8', 1], ['u32', 3], ['u32', 1], ...ring(square)]);
    expect(parseWkbHex(polygon)).toEqual({ type: 'Polygon', coordinates: [square] });
    const multi = ewkb([
      ['u8', 1],
      ['u32', 6 | SRID_FLAG],
      ['u32', 4326],
      ['u32', 1],
      ['u8', 1],
      ['u32', 3],
      ['u32', 1],
      ...ring(square),
    ]);
    expect(parseWkbHex(multi)).toEqual({ type: 'MultiPolygon', coordinates: [[square]] });
  });

  it.each([
    ['not hex', 'zz'],
    [
      'truncated',
      ewkb([
        ['u8', 1],
        ['u32', 1],
        ['f64', 1],
      ]),
    ],
    [
      'unsupported type',
      ewkb([
        ['u8', 1],
        ['u32', 2],
        ['u32', 0],
      ]),
    ],
    [
      'trailing bytes',
      `${ewkb([
        ['u8', 1],
        ['u32', 1],
        ['f64', 1],
        ['f64', 2],
      ])}00`,
    ],
    [
      'multipolygon of points',
      ewkb([
        ['u8', 1],
        ['u32', 6],
        ['u32', 1],
        ['u8', 1],
        ['u32', 1],
        ['f64', 1],
        ['f64', 2],
      ]),
    ],
  ])('rejects %s', (_label, hex) => {
    expect(() => parseWkbHex(hex)).toThrow(ColumnValueError);
  });
});

describe('assertLatLng', () => {
  it('accepts the valid range', () => {
    expect(() => assertLatLng('c', { lat: -90, lng: 180 })).not.toThrow();
  });

  it.each([
    [{ lat: 91, lng: 0 }, /lat out of range/],
    [{ lat: 0, lng: -181 }, /lng out of range/],
    [{ lat: Number.NaN, lng: 0 }, /lat out of range/],
    // A classic swap: Saint-Barthélemy's lng (-62.8) passed as lat is still in range, so only lat > 90 catches swaps
    // of larger longitudes — the named { lat, lng } shape is the real guard.
    [{ lat: 0, lng: Number.POSITIVE_INFINITY }, /lng out of range/],
  ])('rejects %j', (value, message) => {
    expect(() => assertLatLng('c', value)).toThrow(message);
  });
});

describe('vector', () => {
  it('serialises after checking dimension and finiteness', () => {
    expect(toPgVector([1, 2.5, -3], 3)).toBe('[1,2.5,-3]');
    expect(() => toPgVector([1, 2], 3)).toThrow(/expected 3 dimensions, got 2/);
    expect(() => toPgVector([1, Number.NaN, 3], 3)).toThrow(/finite/);
  });

  it('parses the database text form', () => {
    expect(fromPgVector('[1,2.5,-3]')).toEqual([1, 2.5, -3]);
    expect(() => fromPgVector('{"a":1}')).toThrow(ColumnValueError);
  });

  it('requires a positive integer dimension', () => {
    expect(() => vector(0)).toThrow(ColumnValueError);
    expect(() => vector(1.5)).toThrow(ColumnValueError);
    expect(vector(3, 'embedding')).toBeDefined();
  });
});

describe('assertLtree', () => {
  it.each(['food', 'food.restaurant', 'food.fast-food.burger_bar', 'a1.B2'])('accepts %s', (path) => {
    expect(() => assertLtree(path)).not.toThrow();
  });

  it.each(['', 'food.', '.food', 'food..x', 'café', 'a b'])('rejects %j', (path) => {
    expect(() => assertLtree(path)).toThrow(ColumnValueError);
  });
});
