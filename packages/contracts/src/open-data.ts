import { z } from 'zod';
import { BBoxSchema, LatLngSchema, MultiPolygonSchema, PolygonSchema } from './geo.ts';

// Open-data place search on services/intel (BF-019, ADR-0002): Overture Maps Places and Foursquare OS Places are
// queried with DuckDB in the intel service; the API maps the neutral places below to source records.

export const OPEN_DATA_DATASETS = ['overture', 'foursquare'] as const;
export const OpenDataDatasetSchema = z.enum(OPEN_DATA_DATASETS);
export type OpenDataDataset = z.infer<typeof OpenDataDatasetSchema>;

/** Release identifiers as the datasets name them (`2026-09-17.0`, `2026-10-01`). */
const ReleaseSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(\.\d{1,3})?$/);

export const OpenDataGeometrySchema = z.union([
  z.object({ type: z.literal('BBox'), bbox: BBoxSchema }),
  PolygonSchema,
  MultiPolygonSchema,
]);

export const OpenDataSearchRequestSchema = z
  .object({
    dataset: OpenDataDatasetSchema,
    release: ReleaseSchema.optional().describe('Pinned release; the latest known one when omitted.'),
    geometry: OpenDataGeometrySchema,
    categories: z
      .array(z.string().min(1).max(120))
      .max(100)
      .describe(
        'Dataset-native category keys (Overture basic_category, Foursquare category ids); empty = all.',
      ),
    limit: z.number().int().min(1).max(500).default(200),
    cursor: z.string().max(500).optional(),
    hfToken: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Hugging Face token for gated datasets (Foursquare); never logged or cached.'),
  })
  .meta({ id: 'OpenDataSearchRequest' });
export type OpenDataSearchRequest = z.infer<typeof OpenDataSearchRequestSchema>;

const text = (max: number) => z.string().max(max);

export const OpenDataPlaceSchema = z
  .object({
    id: text(200).describe('Dataset id (Overture GERS id, Foursquare fsq_place_id).'),
    name: text(300),
    categories: z
      .array(z.object({ key: text(200), label: text(200).nullable() }))
      .max(30)
      .describe('Primary first.'),
    location: LatLngSchema,
    address: z.object({
      line1: text(300).nullable(),
      city: text(120).nullable(),
      postalCode: text(20).nullable(),
      region: text(120).nullable(),
      countryCode: text(2).nullable(),
    }),
    phones: z.array(text(40)).max(10),
    websites: z.array(text(2_000)).max(10),
    emails: z.array(text(254)).max(10),
    socials: z.array(text(500)).max(10),
    operatingStatus: z.enum(['open', 'temporarily_closed', 'permanently_closed']).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    brand: text(200).nullable(),
    sources: z
      .array(z.object({ dataset: text(120), recordId: text(300).nullable(), license: text(120).nullable() }))
      .max(20)
      .describe('Upstream contributors and their licences (Overture `sources`).'),
  })
  .meta({ id: 'OpenDataPlace' });
export type OpenDataPlace = z.infer<typeof OpenDataPlaceSchema>;

export const OpenDataSearchResponseSchema = z
  .object({
    dataset: OpenDataDatasetSchema,
    release: ReleaseSchema,
    places: z.array(OpenDataPlaceSchema),
    nextCursor: z.string().nullable(),
    cached: z.boolean().describe('Served from the regional extract cache.'),
  })
  .meta({ id: 'OpenDataSearchResponse' });
export type OpenDataSearchResponse = z.infer<typeof OpenDataSearchResponseSchema>;
