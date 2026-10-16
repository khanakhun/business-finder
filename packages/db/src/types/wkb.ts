import { ColumnValueError } from './errors.ts';

/** GeoJSON positions are `[lng, lat]`. */
export type Position = [lng: number, lat: number];
export interface GeoJsonPoint {
  readonly type: 'Point';
  readonly coordinates: Position;
}
export interface GeoJsonPolygon {
  readonly type: 'Polygon';
  readonly coordinates: Position[][];
}
export interface GeoJsonMultiPolygon {
  readonly type: 'MultiPolygon';
  readonly coordinates: Position[][][];
}
export type Geometry = GeoJsonPoint | GeoJsonPolygon | GeoJsonMultiPolygon;

const WKB_POINT = 1;
const WKB_POLYGON = 3;
const WKB_MULTIPOLYGON = 6;
const FLAG_Z = 0x80000000;
const FLAG_M = 0x40000000;
const FLAG_SRID = 0x20000000;

/**
 * Parses PostGIS (E)WKB hex — what `geography`/`geometry` columns return over the wire — into GeoJSON.
 * Supports the shapes we store (Point, Polygon, MultiPolygon); Z/M ordinates are dropped.
 */
export function parseWkbHex(hex: string): Geometry {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex))
    throw new ColumnValueError('geography', 'not a hex-encoded WKB value');
  const reader = new WkbReader(Buffer.from(hex, 'hex'));
  const geometry = reader.geometry();
  if (!reader.done) throw new ColumnValueError('geography', 'trailing bytes after WKB geometry');
  return geometry;
}

class WkbReader {
  #offset = 0;
  #littleEndian = true;
  readonly #view: DataView;

  constructor(buffer: Buffer) {
    this.#view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  get done(): boolean {
    return this.#offset === this.#view.byteLength;
  }

  geometry(): Geometry {
    const { type, dims } = this.#header();
    switch (type) {
      case WKB_POINT:
        return { type: 'Point', coordinates: this.#position(dims) };
      case WKB_POLYGON:
        return { type: 'Polygon', coordinates: this.#rings(dims) };
      case WKB_MULTIPOLYGON: {
        const polygons: Position[][][] = [];
        for (let i = this.#uint32(); i > 0; i--) {
          const part = this.geometry();
          if (part.type !== 'Polygon')
            throw new ColumnValueError('geography', 'MultiPolygon member is not a Polygon');
          polygons.push(part.coordinates);
        }
        return { type: 'MultiPolygon', coordinates: polygons };
      }
      default:
        throw new ColumnValueError('geography', `unsupported WKB geometry type ${type}`);
    }
  }

  #header(): { type: number; dims: number } {
    this.#ensure(5);
    this.#littleEndian = this.#view.getUint8(this.#offset) === 1;
    this.#offset += 1;
    const raw = this.#uint32();
    if (raw & FLAG_SRID) this.#uint32(); // SRID: geography is always 4326 here
    // ISO WKB encodes Z/M as +1000/+2000/+3000 on the type code; EWKB uses the high flag bits.
    const iso = Math.floor((raw & 0x0fffffff) / 1000);
    const type = (raw & 0x0fffffff) % 1000;
    const dims =
      2 + (raw & FLAG_Z || iso === 1 || iso === 3 ? 1 : 0) + (raw & FLAG_M || iso === 2 || iso === 3 ? 1 : 0);
    return { type, dims };
  }

  #rings(dims: number): Position[][] {
    const rings: Position[][] = [];
    for (let r = this.#uint32(); r > 0; r--) {
      const ring: Position[] = [];
      for (let p = this.#uint32(); p > 0; p--) ring.push(this.#position(dims));
      rings.push(ring);
    }
    return rings;
  }

  #position(dims: number): Position {
    const lng = this.#double();
    const lat = this.#double();
    for (let extra = dims - 2; extra > 0; extra--) this.#double();
    return [lng, lat];
  }

  #uint32(): number {
    this.#ensure(4);
    const value = this.#view.getUint32(this.#offset, this.#littleEndian);
    this.#offset += 4;
    return value;
  }

  #double(): number {
    this.#ensure(8);
    const value = this.#view.getFloat64(this.#offset, this.#littleEndian);
    this.#offset += 8;
    return value;
  }

  #ensure(bytes: number): void {
    if (this.#offset + bytes > this.#view.byteLength)
      throw new ColumnValueError('geography', 'truncated WKB value');
  }
}
