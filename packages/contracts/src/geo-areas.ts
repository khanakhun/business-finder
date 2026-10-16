import { z } from 'zod';
import { BBoxSchema, CountryCodeSchema, LatLngSchema, MultiPolygonSchema, PolygonSchema } from './geo.ts';
import { LocaleSchema } from './i18n.ts';

// Geographic areas and location resolution (BF-017): what users type to scope searches ("St Barth", "Gustavia",
// "1012", "33139", "within 3 km of Lorient") and the geometries discovery tiles.

export const GEO_AREA_KINDS = [
  'country',
  'admin1',
  'admin2',
  'locality',
  'district',
  'postal_code',
  'island',
  'custom',
] as const;
export const GeoAreaKindSchema = z.enum(GEO_AREA_KINDS);
export type GeoAreaKind = z.infer<typeof GeoAreaKindSchema>;

export const GEO_AREA_SOURCES = [
  'osm',
  'overture',
  'census',
  'pdok',
  'custom',
  'nominatim',
  'google',
] as const;
export const GeoAreaSourceSchema = z.enum(GEO_AREA_SOURCES);
export type GeoAreaSource = z.infer<typeof GeoAreaSourceSchema>;

export const GeoAreaNameSchema = z
  .object({ en: z.string().min(1), fr: z.string().min(1), local: z.string().min(1).optional() })
  .meta({ id: 'GeoAreaName' });

/** A circle around a point (radius search, geocoder points). */
export const CircleGeometrySchema = z
  .object({ type: z.literal('Circle'), center: LatLngSchema, radiusM: z.number().positive().max(200_000) })
  .meta({ id: 'CircleGeometry' });
export type CircleGeometry = z.infer<typeof CircleGeometrySchema>;

export const AreaGeometrySchema = z
  .union([MultiPolygonSchema, CircleGeometrySchema])
  .meta({ id: 'AreaGeometry' });
export type AreaGeometry = z.infer<typeof AreaGeometrySchema>;

export const GeoAreaSummarySchema = z
  .object({
    id: z.uuid(),
    kind: GeoAreaKindSchema,
    countryCode: z.string().nullable(),
    code: z.string().nullable(),
    name: GeoAreaNameSchema,
    label: z.string().describe('Name in the requested locale, with its parent for context ("Gustavia, BL").'),
    parentId: z.uuid().nullable(),
    approximate: z.boolean().describe('Boundary derived from points (e.g. Voronoi cells), not surveyed.'),
    source: GeoAreaSourceSchema,
    areaKm2: z.number().nullable(),
    centroid: LatLngSchema.nullable(),
    bbox: BBoxSchema.nullable(),
  })
  .meta({ id: 'GeoAreaSummary' });
export type GeoAreaSummary = z.infer<typeof GeoAreaSummarySchema>;

/** `GET /v1/geo/areas/:id`: a GeoJSON Feature. */
export const GeoAreaFeatureSchema = z
  .object({
    type: z.literal('Feature'),
    id: z.uuid(),
    geometry: MultiPolygonSchema,
    properties: GeoAreaSummarySchema.omit({ id: true }),
  })
  .meta({ id: 'GeoAreaFeature' });
export type GeoAreaFeature = z.infer<typeof GeoAreaFeatureSchema>;

export const GeoAreaQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  kind: GeoAreaKindSchema.optional(),
  country: CountryCodeSchema.optional(),
  locale: LocaleSchema.default('en'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type GeoAreaQuery = z.infer<typeof GeoAreaQuerySchema>;

export const GeoAreaListSchema = z
  .object({ items: z.array(GeoAreaSummarySchema) })
  .meta({ id: 'GeoAreaList' });
export type GeoAreaList = z.infer<typeof GeoAreaListSchema>;

export const LOCATION_SOURCES = ['pattern', 'local', 'geocoder'] as const;

export const AreaCandidateSchema = z
  .object({
    areaId: z.uuid().nullable().describe('Set when the candidate is a stored area.'),
    kind: GeoAreaKindSchema,
    label: z.string(),
    geometry: AreaGeometrySchema,
    bbox: BBoxSchema,
    confidence: z.number().min(0).max(1),
    source: z.enum(LOCATION_SOURCES),
  })
  .meta({ id: 'AreaCandidate' });
export type AreaCandidate = z.infer<typeof AreaCandidateSchema>;

/** Why external geocoding was skipped: provider down, or the workspace's lookup quota is spent. */
export const LOCATION_NOTICES = ['geocoder_unavailable', 'geocoder_quota'] as const;
export type LocationNotice = (typeof LOCATION_NOTICES)[number];

export const LocationResolutionSchema = z
  .object({
    query: z.string(),
    candidates: z.array(AreaCandidateSchema),
    chosen: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Index of the confident pick, null when ambiguous or none.'),
    notice: z
      .enum(LOCATION_NOTICES)
      .nullable()
      .describe('Set when the external geocoder could not be asked, so candidates may be incomplete.'),
  })
  .meta({ id: 'LocationResolution' });
export type LocationResolution = z.infer<typeof LocationResolutionSchema>;

export const ResolveLocationQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  locale: LocaleSchema.default('en'),
  country: CountryCodeSchema.optional().describe('Overrides the workspace default country hint.'),
});
export type ResolveLocationQuery = z.infer<typeof ResolveLocationQuerySchema>;

/** `POST /v1/geo/areas`: a custom area drawn on the map. */
/** Drawn areas stay small enough to store, index and tile cheaply. */
export const MAX_CUSTOM_AREA_VERTICES = 5_000;
export const MAX_CUSTOM_AREA_RINGS = 20;
const ringsOf = (g: z.infer<typeof PolygonSchema> | z.infer<typeof MultiPolygonSchema>) =>
  g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();

export const CreateCustomAreaRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    geometry: z
      .union([PolygonSchema, MultiPolygonSchema])
      .refine((g) => ringsOf(g).length <= MAX_CUSTOM_AREA_RINGS, {
        message: `At most ${MAX_CUSTOM_AREA_RINGS} rings`,
      })
      .refine((g) => ringsOf(g).reduce((n, ring) => n + ring.length, 0) <= MAX_CUSTOM_AREA_VERTICES, {
        message: `At most ${MAX_CUSTOM_AREA_VERTICES} vertices`,
      }),
  })
  .meta({ id: 'CreateCustomAreaRequest' });
export type CreateCustomAreaRequest = z.infer<typeof CreateCustomAreaRequestSchema>;
