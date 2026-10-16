import { type BBox, type CircleGeometry, type MultiPolygon, ValidationError } from '@bf/contracts';
import { booleanIntersects } from '@turf/boolean-intersects';
import { circle as turfCircle } from '@turf/circle';
import { featureCollection, polygon as turfPolygon } from '@turf/helpers';
import { intersect } from '@turf/intersect';
import type { Feature, MultiPolygon as GeoJsonMultiPolygon, Polygon as GeoJsonPolygon } from 'geojson';
import { bboxOf } from './geometry.ts';

// Tiling (BF-017): splits an area into provider-sized queries for discovery (BF-020). Pure functions on Turf.js,
// so they run in tests without a database or network.

const KM_PER_DEGREE_LAT = 110.574;
const kmPerDegreeLng = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);

/** Most tiles one call may produce: beyond this the cell size is wrong for the area (or the area is a continent). */
export const MAX_TILES = 10_000;
const MIN_CELL_KM = 0.05;

/** Typed so a caller passing a bad cell size or area gets a 422, not a 500. */
export class TilingError extends ValidationError {
  constructor(message: string) {
    super(message, [{ path: ['geometry'], message }]);
  }
}

/** Areas crossing ±180° need splitting first: Turf's bbox would span the whole globe. */
function assertTileable(box: BBox): void {
  if (box.east - box.west > 180) throw new TilingError('Areas crossing the antimeridian are not supported');
}

const guardCount = (count: number) => {
  if (count > MAX_TILES) throw new TilingError(`More than ${MAX_TILES} tiles: use larger cells`);
};

export interface BBoxTile {
  readonly bbox: BBox;
  /** The part of the area inside the cell. */
  readonly geometry: MultiPolygon;
}

export const bboxPolygon = (box: BBox): GeoJsonPolygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [box.west, box.south],
      [box.east, box.south],
      [box.east, box.north],
      [box.west, box.north],
      [box.west, box.south],
    ],
  ],
});

function clip(area: MultiPolygon, box: BBox): MultiPolygon | null {
  const areaFeature: Feature<GeoJsonMultiPolygon | GeoJsonPolygon> = {
    type: 'Feature',
    properties: {},
    geometry: area as GeoJsonMultiPolygon,
  };
  const clipped = intersect(featureCollection([areaFeature, turfPolygon(bboxPolygon(box).coordinates)]));
  if (!clipped) return null;
  const g = clipped.geometry;
  return g.type === 'MultiPolygon'
    ? (g as MultiPolygon)
    : ({ type: 'MultiPolygon', coordinates: [g.coordinates] } as MultiPolygon);
}

/** Square-ish cells of `cellKm` covering the area's bbox, kept (and clipped) where they touch the area. */
export function tileAsBBoxes(area: MultiPolygon, cellKm: number): BBoxTile[] {
  if (!(cellKm >= MIN_CELL_KM)) throw new TilingError(`cellKm must be at least ${MIN_CELL_KM}`);
  const box = bboxOf(area);
  assertTileable(box);
  // Longitude steps are sized where a degree is longest (nearest the equator), so no cell is wider than `cellKm`.
  const widestLat = box.south <= 0 && box.north >= 0 ? 0 : Math.min(Math.abs(box.south), Math.abs(box.north));
  const dLat = cellKm / KM_PER_DEGREE_LAT;
  const dLng = cellKm / Math.max(1e-6, kmPerDegreeLng(widestLat));
  guardCount(Math.ceil((box.north - box.south) / dLat) * Math.ceil((box.east - box.west) / dLng));
  const tiles: BBoxTile[] = [];
  for (let south = box.south; south < box.north; south += dLat) {
    for (let west = box.west; west < box.east; west += dLng) {
      const cell = {
        west,
        south,
        east: Math.min(west + dLng, box.east),
        north: Math.min(south + dLat, box.north),
      };
      const geometry = clip(area, cell);
      if (geometry) tiles.push({ bbox: cell, geometry });
    }
  }
  return tiles;
}

/**
 * Circles of `radiusM` on a hexagonal lattice (centres √3·r apart in rows 1.5·r apart) — the densest covering of
 * the plane by equal circles — kept where they touch the area. Every point of the area lies in some circle.
 */
export function tileAsCircles(area: MultiPolygon, radiusM: number): CircleGeometry[] {
  if (!(radiusM >= MIN_CELL_KM * 1000))
    throw new TilingError(`radiusM must be at least ${MIN_CELL_KM * 1000}`);
  const box = bboxOf(area);
  assertTileable(box);
  const rKm = radiusM / 1000;
  const rowStep = (1.5 * rKm) / KM_PER_DEGREE_LAT;
  // Column spacing depends on latitude: computed per row (a single mid-latitude step leaves gaps on tall areas).
  const colStepAt = (lat: number) => (Math.sqrt(3) * rKm) / Math.max(1e-6, kmPerDegreeLng(lat));
  const marginLat = rKm / KM_PER_DEGREE_LAT;
  const poleward = Math.max(Math.abs(box.south), Math.abs(box.north));
  const marginLng = rKm / Math.max(1e-6, kmPerDegreeLng(Math.min(89, poleward + marginLat)));
  guardCount(
    Math.ceil((box.north - box.south + 2 * marginLat) / rowStep + 1) *
      Math.ceil((box.east - box.west + 2 * marginLng) / colStepAt(Math.min(89, poleward + marginLat)) + 1),
  );
  const circles: CircleGeometry[] = [];
  const feature: Feature<GeoJsonMultiPolygon> = {
    type: 'Feature',
    properties: {},
    geometry: area as GeoJsonMultiPolygon,
  };
  let row = 0;
  for (let lat = box.south - marginLat; lat <= box.north + marginLat; lat += rowStep, row++) {
    // A row's circles must also cover the band between it and its neighbours: space them for the band's
    // poleward edge, where a degree of longitude is shortest.
    const edge = Math.min(89, Math.max(Math.abs(lat - rowStep), Math.abs(lat + rowStep)));
    const colStep = colStepAt(edge);
    const offset = row % 2 === 0 ? 0 : colStep / 2;
    for (let lng = box.west - marginLng + offset; lng <= box.east + marginLng; lng += colStep) {
      const disk = turfCircle([lng, lat], rKm, { steps: 24, units: 'kilometers' });
      if (booleanIntersects(disk, feature)) {
        circles.push({ type: 'Circle', center: { lat: round(lat), lng: round(lng) }, radiusM });
      }
    }
  }
  return circles;
}

/** Quadtree split of a tile into four (adaptive discovery splits saturated tiles), clipped to `area` if given. */
export function subdivide(tile: BBox, area?: MultiPolygon): BBoxTile[] {
  const midLat = (tile.south + tile.north) / 2;
  const midLng = (tile.west + tile.east) / 2;
  const quads: BBox[] = [
    { west: tile.west, south: tile.south, east: midLng, north: midLat },
    { west: midLng, south: tile.south, east: tile.east, north: midLat },
    { west: tile.west, south: midLat, east: midLng, north: tile.north },
    { west: midLng, south: midLat, east: tile.east, north: tile.north },
  ];
  return quads.flatMap((bbox) => {
    if (!area)
      return [
        {
          bbox,
          geometry: { type: 'MultiPolygon', coordinates: [bboxPolygon(bbox).coordinates] } as MultiPolygon,
        },
      ];
    const geometry = clip(area, bbox);
    return geometry ? [{ bbox, geometry }] : [];
  });
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
