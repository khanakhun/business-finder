import type { BBox, CircleGeometry, LatLng, MultiPolygon, Polygon } from '@bf/contracts';
import { area as turfArea } from '@turf/area';
import { bbox as turfBbox } from '@turf/bbox';
import { centroid as turfCentroid } from '@turf/centroid';
import { circle as turfCircle } from '@turf/circle';
import type { MultiPolygon as GeoJsonMultiPolygon } from 'geojson';

// Geometry helpers (BF-017). GeoJSON positions are [lng, lat]; our APIs speak `{ lat, lng }` — conversions happen
// here only.

export function toMultiPolygon(geometry: Polygon | MultiPolygon): MultiPolygon {
  return geometry.type === 'MultiPolygon'
    ? geometry
    : { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
}

/** A circle as a 48-sided polygon (for bboxes, intersections and map display). */
export function circleToMultiPolygon(circle: CircleGeometry, steps = 48): MultiPolygon {
  const polygon = turfCircle([circle.center.lng, circle.center.lat], circle.radiusM / 1000, {
    steps,
    units: 'kilometers',
  });
  return {
    type: 'MultiPolygon',
    coordinates: [polygon.geometry.coordinates as MultiPolygon['coordinates'][number]],
  };
}

export function asMultiPolygon(geometry: MultiPolygon | CircleGeometry): MultiPolygon {
  return geometry.type === 'Circle' ? circleToMultiPolygon(geometry) : geometry;
}

export function bboxOf(geometry: MultiPolygon | CircleGeometry): BBox {
  const [west, south, east, north] = turfBbox(asMultiPolygon(geometry) as GeoJsonMultiPolygon) as [
    number,
    number,
    number,
    number,
  ];
  return { west, south, east, north };
}

export function areaKm2(geometry: MultiPolygon): number {
  return Math.round((turfArea(geometry as GeoJsonMultiPolygon) / 1_000_000) * 1000) / 1000;
}

export function centroidOf(geometry: MultiPolygon): LatLng {
  const [lng, lat] = turfCentroid(geometry as GeoJsonMultiPolygon).geometry.coordinates as [number, number];
  return { lat, lng };
}
