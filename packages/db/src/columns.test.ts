import { PgDialect, pgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { id, orgId, timestamps } from './columns.ts';
import { geographyMultiPolygon, geographyPoint } from './types/geography.ts';
import { citext, ltree, tsvector } from './types/text.ts';
import { vector } from './types/vector.ts';

const things = pgTable('things', {
  id: id(),
  organizationId: orgId(),
  location: geographyPoint(),
  area: geographyMultiPolygon(),
  embedding: vector(3),
  path: ltree(),
  email: citext(),
  search: tsvector(),
  ...timestamps(),
});

const dialect = new PgDialect({ casing: 'snake_case' });
const toSql = (value: unknown) => {
  // mapToDriverValue returns either a driver value or an SQL fragment; render fragments to inspect them.
  const query = dialect.sqlToQuery(value as Parameters<PgDialect['sqlToQuery']>[0]);
  return { sql: query.sql, params: query.params };
};

describe('column helpers', () => {
  it('generates time-ordered UUIDv7 ids in the app', () => {
    const generate = things.id.defaultFn;
    expect(generate).toBeDefined();
    const first = String(generate?.());
    const second = String(generate?.());
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first < second).toBe(true);
  });

  it('declares the expected SQL types', () => {
    expect(things.id.getSQLType()).toBe('uuid');
    expect(things.organizationId.name).toBe('organization_id');
    expect(things.organizationId.notNull).toBe(true);
    expect(things.location.getSQLType()).toBe('geography(Point,4326)');
    expect(things.area.getSQLType()).toBe('geography(MultiPolygon,4326)');
    expect(things.embedding.getSQLType()).toBe('vector(3)');
    expect(things.path.getSQLType()).toBe('ltree');
    expect(things.email.getSQLType()).toBe('citext');
    expect(things.search.getSQLType()).toBe('tsvector');
    expect(things.createdAt.getSQLType()).toBe('timestamp with time zone');
    expect(things.updatedAt.hasDefault).toBe(true);
  });
});

describe('driver mappings', () => {
  it('writes points as ST_MakePoint(lng, lat)', () => {
    const { sql, params } = toSql(things.location.mapToDriverValue({ lat: 17.9, lng: -62.85 }));
    expect(sql).toBe('ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography');
    expect(params).toEqual([-62.85, 17.9]);
  });

  it('rejects out-of-range points before hitting the database', () => {
    expect(() => things.location.mapToDriverValue({ lat: -62.85, lng: 200 })).toThrow(/lng out of range/);
  });

  it('reads points back as { lat, lng }', () => {
    const buf = Buffer.alloc(25);
    buf.writeUInt8(1, 0);
    buf.writeUInt32LE(0x20000001, 1);
    buf.writeUInt32LE(4326, 5);
    buf.writeDoubleLE(-62.85, 9);
    buf.writeDoubleLE(17.9, 17);
    expect(things.location.mapFromDriverValue(buf.toString('hex'))).toEqual({ lat: 17.9, lng: -62.85 });
  });

  it('rejects a non-point geography in a point column', () => {
    const polygon = Buffer.alloc(9);
    polygon.writeUInt8(1, 0);
    polygon.writeUInt32LE(3, 1);
    polygon.writeUInt32LE(0, 5);
    expect(() => things.location.mapFromDriverValue(polygon.toString('hex'))).toThrow(/expected Point/);
  });

  const square = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ];

  it('writes polygons as GeoJSON, promoting Polygon to MultiPolygon', () => {
    const { sql, params } = toSql(
      things.area.mapToDriverValue({ type: 'Polygon', coordinates: [square] } as never),
    );
    expect(sql).toBe('ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))::geography');
    expect(JSON.parse(String(params[0]))).toEqual({ type: 'Polygon', coordinates: [square] });
  });

  it.each([
    [{ type: 'Point', coordinates: [0, 0] }, /Polygon or MultiPolygon/],
    [{ type: 'MultiPolygon', coordinates: [[square.slice(0, 3)]] }, /at least 4 positions/],
    [{ type: 'MultiPolygon', coordinates: [[[...square.slice(0, 3), [5, 5]]]] }, /closed/],
    [
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [0, 95],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
      /lat out of range/,
    ],
  ])('rejects invalid polygons %#', (value, message) => {
    expect(() => things.area.mapToDriverValue(value as never)).toThrow(message);
  });

  it('reads a stored polygon back as a MultiPolygon', () => {
    const buf = Buffer.alloc(9 + 4 + 4 * 16);
    let o = buf.writeUInt8(1, 0);
    o = buf.writeUInt32LE(3, o);
    o = buf.writeUInt32LE(1, o);
    o = buf.writeUInt32LE(4, o);
    for (const [x, y] of square) {
      o = buf.writeDoubleLE(x as number, o);
      o = buf.writeDoubleLE(y as number, o);
    }
    expect(things.area.mapFromDriverValue(buf.toString('hex'))).toEqual({
      type: 'MultiPolygon',
      coordinates: [[square]],
    });
  });

  it('rejects a point in a polygon column', () => {
    const buf = Buffer.alloc(21);
    buf.writeUInt8(1, 0);
    buf.writeUInt32LE(1, 1);
    expect(() => things.area.mapFromDriverValue(buf.toString('hex'))).toThrow(/expected MultiPolygon/);
  });

  it('checks vector dimension against the column on write', () => {
    expect(things.embedding.mapToDriverValue([1, 2, 3])).toBe('[1,2,3]');
    expect(() => things.embedding.mapToDriverValue([1, 2])).toThrow(/expected 3 dimensions/);
    expect(things.embedding.mapFromDriverValue('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('validates ltree paths on write', () => {
    expect(things.path.mapToDriverValue('food.restaurant')).toBe('food.restaurant');
    expect(() => things.path.mapToDriverValue('food..restaurant')).toThrow(/invalid path/);
  });
});
