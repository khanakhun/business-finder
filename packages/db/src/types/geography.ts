import { sql } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';
import { ColumnValueError } from './errors.ts';
import { type GeoJsonMultiPolygon, type GeoJsonPolygon, type Position, parseWkbHex } from './wkb.ts';

/**
 * A WGS84 point. Named fields on purpose: GeoJSON and PostGIS order coordinates `lng, lat`, people say
 * `lat, lng` — `{ lat, lng }` makes swaps impossible to write by accident.
 */
export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export function assertLatLng(column: string, value: LatLng): void {
  const { lat, lng } = value;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90)
    throw new ColumnValueError(column, `lat out of range: ${lat}`);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180)
    throw new ColumnValueError(column, `lng out of range: ${lng}`);
}

/** `geography(Point,4326)` ⇄ `{ lat, lng }`. Written with `ST_MakePoint(lng, lat)`. */
export const geographyPoint = customType<{ data: LatLng; driverData: string }>({
  dataType: () => 'geography(Point,4326)',
  toDriver(value) {
    assertLatLng('geographyPoint', value);
    return sql`ST_SetSRID(ST_MakePoint(${value.lng}, ${value.lat}), 4326)::geography`;
  },
  fromDriver(value) {
    const geometry = parseWkbHex(value);
    if (geometry.type !== 'Point')
      throw new ColumnValueError('geographyPoint', `expected Point, got ${geometry.type}`);
    const [lng, lat] = geometry.coordinates;
    return { lat, lng };
  },
});

/** `geography(MultiPolygon,4326)` ⇄ GeoJSON MultiPolygon. A Polygon is accepted on write and promoted. */
export const geographyMultiPolygon = customType<{
  data: GeoJsonMultiPolygon;
  driverData: string;
}>({
  dataType: () => 'geography(MultiPolygon,4326)',
  toDriver(value: GeoJsonMultiPolygon | GeoJsonPolygon) {
    assertPolygonal(value);
    return sql`ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(value)}), 4326))::geography`;
  },
  fromDriver(value) {
    const geometry = parseWkbHex(value);
    if (geometry.type === 'Polygon') return { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
    if (geometry.type !== 'MultiPolygon') {
      throw new ColumnValueError('geographyMultiPolygon', `expected MultiPolygon, got ${geometry.type}`);
    }
    return geometry;
  },
});

function assertPolygonal(value: GeoJsonMultiPolygon | GeoJsonPolygon): void {
  const polygons =
    value.type === 'Polygon' ? [value.coordinates] : value.type === 'MultiPolygon' ? value.coordinates : null;
  if (!polygons)
    throw new ColumnValueError('geographyMultiPolygon', 'expected a GeoJSON Polygon or MultiPolygon');
  for (const ring of polygons.flat()) {
    if (ring.length < 4)
      throw new ColumnValueError('geographyMultiPolygon', 'a ring needs at least 4 positions');
    const first = ring[0] as Position;
    const last = ring[ring.length - 1] as Position;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw new ColumnValueError('geographyMultiPolygon', 'rings must be closed (first position = last)');
    }
    for (const [lng, lat] of ring) assertLatLng('geographyMultiPolygon', { lat, lng });
  }
}
