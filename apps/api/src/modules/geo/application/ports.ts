import type { BBox, GeoAreaKind, GeoAreaSource, LatLng, Locale, MultiPolygon } from '@bf/contracts';

// Ports of the geo module (BF-017).

export interface GeoAreaRecord {
  readonly id: string;
  readonly kind: GeoAreaKind;
  readonly countryCode: string | null;
  readonly code: string | null;
  readonly name: { readonly en: string; readonly fr: string; readonly local?: string };
  readonly aliases: readonly string[];
  readonly parentId: string | null;
  readonly approximate: boolean;
  readonly source: GeoAreaSource;
  readonly sourceRef: string | null;
  readonly areaKm2: number | null;
  readonly centroid: LatLng | null;
  readonly bbox: BBox | null;
  readonly organizationId: string | null;
}

export interface GeoAreaInput {
  readonly kind: GeoAreaKind;
  readonly countryCode: string | null;
  readonly code: string | null;
  readonly name: { readonly en: string; readonly fr: string; readonly local?: string };
  readonly aliases: readonly string[];
  /** Parent by its source reference (resolved by the repository), e.g. the island of a quarter. */
  readonly parentSourceRef?: string | null;
  readonly geometry: MultiPolygon;
  readonly approximate: boolean;
  readonly source: GeoAreaSource;
  readonly sourceRef: string | null;
  readonly organizationId?: string | null;
}

export interface AreaMatch {
  readonly area: GeoAreaRecord;
  /** 1 for an exact name/alias match, else trigram similarity. */
  readonly score: number;
  readonly exact: boolean;
}

export interface GeoAreaRepository {
  /** Inserts or updates by (source, source_ref); returns the id and whether anything changed. */
  upsert(area: GeoAreaInput): Promise<{ readonly id: string; readonly changed: boolean }>;
  /** Areas named `text` (exact normalized names first, then trigram), visible to the workspace. */
  match(
    text: string,
    filter: {
      readonly organizationId: string | null;
      readonly kind?: GeoAreaKind;
      readonly countryCode?: string;
      readonly limit: number;
    },
  ): Promise<AreaMatch[]>;
  findByCode(kind: GeoAreaKind, code: string, countryCode: string): Promise<GeoAreaRecord | undefined>;
  /** An area visible to the workspace (global, or its own custom one). */
  getById(id: string, organizationId: string | null): Promise<GeoAreaRecord | undefined>;
  geometryOf(id: string, organizationId: string | null): Promise<MultiPolygon | undefined>;
  /** Display geometries (simplified to ~10 m) of areas visible to the workspace, by id. */
  displayGeometries(
    ids: readonly string[],
    organizationId: string | null,
  ): Promise<Map<string, MultiPolygon>>;
  /** Parent names for labels ("Gustavia, Saint-Barthélemy"), for areas visible to the workspace. */
  names(ids: readonly string[], organizationId: string | null): Promise<Map<string, GeoAreaRecord['name']>>;
  /** Why PostGIS rejects a geometry (self-intersection…), or null when it is valid. */
  invalidReason(geometry: MultiPolygon): Promise<string | null>;
  countCustom(organizationId: string): Promise<number>;
}
export const GEO_AREA_REPOSITORY = Symbol('GeoAreaRepository');

export interface GeocodeResult {
  readonly label: string;
  readonly countryCode: string | null;
  readonly kind: GeoAreaKind;
  /** Whether the answer may be stored as a shared area (administrative/place boundaries from open data only). */
  readonly persistable: boolean;
  readonly center: LatLng;
  readonly bbox: BBox | null;
  /** Polygon boundaries when the geocoder returns them. */
  readonly geometry: MultiPolygon | null;
  /** Provider's id (e.g. `osm:relation/123`). */
  readonly sourceRef: string;
  /** 0–1 relevance from the provider. */
  readonly importance: number;
}

export interface GeocodeQuery {
  readonly text: string;
  readonly countryHint: string | null;
  /** Restrict answers to `countryHint` (explicit country, postcode lookups); otherwise it only biases ranking. */
  readonly strictCountry: boolean;
  readonly locale: Locale;
  readonly orgId: string | null;
}

/** Strategy: an external geocoder (Nominatim, Google). */
export interface Geocoder {
  readonly provider: 'nominatim' | 'google';
  /** Whether answers depend on the workspace's own key (cached per workspace, never shared). */
  readonly perWorkspace: boolean;
  /** How long answers may be cached (provider terms: Google ≤ 30 days). */
  readonly cacheDays: number;
  geocode(query: GeocodeQuery): Promise<GeocodeResult[]>;
}
export const GEOCODER = Symbol('Geocoder');

export interface GeocodeCacheKey {
  readonly query: string;
  readonly provider: string;
  readonly countryHint: string;
  readonly locale: string;
  /** '' when shareable, else the workspace id. */
  readonly scope: string;
}

export interface GeocodeCache {
  get(key: GeocodeCacheKey): Promise<GeocodeResult[] | undefined>;
  /** Stores an answer for `ttlSeconds` (and prunes a batch of expired entries). */
  put(key: GeocodeCacheKey, results: readonly GeocodeResult[], ttlSeconds: number): Promise<void>;
}
export const GEOCODE_CACHE = Symbol('GeocodeCache');

/** Per-workspace allowance of external geocoder lookups (fair use of a shared, rate-limited provider). */
export interface GeocodeQuota {
  /** Takes one lookup; false when the workspace has used its allowance for the current window. */
  take(organizationId: string | null): Promise<boolean>;
}
export const GEOCODE_QUOTA = Symbol('GeocodeQuota');
