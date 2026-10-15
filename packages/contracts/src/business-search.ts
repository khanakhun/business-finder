import { z } from 'zod';
import { AddedViaSchema, BusinessSummarySchema, PIPELINE_STATUSES } from './business.ts';
import { EnrichmentListingStatusSchema } from './enrichment.ts';
import { BusinessId } from './ids.ts';
import { defineJob } from './jobs.ts';
import { CursorPageRequestSchema, cursorPage } from './pagination.ts';
import { SCORE_TIERS, ScoreTierSchema } from './search-intent.ts';
import { IsoDateTimeSchema } from './time.ts';

// Listing search (BF-022): `GET /v1/businesses` and `/v1/businesses/facets` share these query parameters
// (api.md §3): repeated keys or comma lists for multi-values, `[gte]`/`[lte]` ranges, `true|false` booleans.
// Query schemas stay flat and free of named schemas (each property becomes one OpenAPI query parameter).

/** `?k=a&k=b` and `?k=a,b` both become `['a', 'b']`. */
const many = <T extends z.ZodType<unknown, string>>(item: T, max: number) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : [value])
        .flatMap((v) => v.split(','))
        .map((v) => v.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).max(max))
    .optional();

const bool = () =>
  z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional();

const range = (min: number, max: number, int: boolean) => {
  const n = z.coerce.number().min(min).max(max);
  return (int ? n.int() : n).optional();
};

export const BUSINESS_SORTS = [
  'relevance',
  '-score',
  'score',
  '-rating',
  'rating',
  '-reviews',
  'reviews',
  'distance',
  '-recent',
  'recent',
  'name',
] as const;
export type BusinessSort = (typeof BUSINESS_SORTS)[number];

/** `lat,lng` in decimal degrees. */
const NEAR = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** Every filter of the listing (no paging, no sort): also what a saved search stores. */
export const BusinessFiltersSchema = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Free text: names, categories, places, description.'),
  keyword: many(z.string().min(1).max(60), 10).describe('Terms every result must match (full text).'),
  category: many(z.uuid(), 20).describe('Category ids; their subcategories are included.'),
  area: z.uuid().optional().describe('A geo area id (BF-017): businesses inside it.'),
  near: z
    .string()
    .regex(NEAR, 'Expected "lat,lng"')
    .transform((value) => {
      const [, lat, lng] = NEAR.exec(value) as RegExpExecArray;
      return { lat: Number(lat), lng: Number(lng) };
    })
    .refine((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180, 'Coordinates out of range')
    .optional()
    .describe('Centre point "lat,lng" (with `radiusKm`).'),
  radiusKm: z.coerce.number().positive().max(500).default(5).describe('Radius around `near`, in km.'),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .describe('ISO 3166-1 alpha-2.'),
  website: z
    .enum(['any', 'none', 'has', 'weak'])
    .default('any')
    .describe('`weak` needs website audits (BF-030); until then it behaves as `has`.'),
  'rating[gte]': range(0, 5, false),
  'rating[lte]': range(0, 5, false),
  'reviews[gte]': range(0, 10_000_000, true),
  'reviews[lte]': range(0, 10_000_000, true),
  'score[gte]': range(0, 100, true),
  'score[lte]': range(0, 100, true),
  price: many(z.enum(['0', '1', '2', '3', '4']).transform(Number), 5).describe('Price levels 0–4.'),
  hasEmail: bool(),
  hasPhone: bool(),
  emailVerified: bool(),
  status: many(z.enum(PIPELINE_STATUSES), PIPELINE_STATUSES.length).describe('Pipeline statuses.'),
  tier: many(z.enum(SCORE_TIERS), SCORE_TIERS.length),
  tag: many(z.string().min(1).max(50), 20).describe('Any of these tags.'),
  owner: z.uuid().optional().describe('Owner user id.'),
  list: z.uuid().optional().describe('Businesses in this list (of the workspace).'),
  run: z.uuid().optional().describe('Businesses a discovery run added to the workspace.'),
  id: many(z.uuid(), 200).describe('Only these businesses (e.g. exporting a selection; at most 200).'),
  addedWithinDays: z.coerce.number().int().min(1).max(3_650).optional(),
  includeClosed: bool().describe('Include permanently closed businesses (excluded by default).'),
});
export type BusinessFilters = z.output<typeof BusinessFiltersSchema>;
/** Filters as sent (query-string form), e.g. what the dashboard keeps in its URL and saved searches store. */
export type BusinessFiltersInput = z.input<typeof BusinessFiltersSchema>;

export const BusinessSearchQuerySchema = BusinessFiltersSchema.extend({
  ...CursorPageRequestSchema.shape,
  sort: z
    .enum(BUSINESS_SORTS)
    .optional()
    .describe('Default: `relevance` with `q` or keywords, else `-recent` (most recently tracked first).'),
});
export type BusinessSearchQuery = z.output<typeof BusinessSearchQuerySchema>;

export const EXPORT_FIELDS = [
  'id',
  'name',
  'category',
  'website',
  'locality',
  'address',
  'postal_code',
  'country',
  'lat',
  'lng',
  'rating',
  'reviews',
  'status',
  'score',
  'tier',
  'tags',
  'tracked_at',
  // The business's public phone, as the listing shows it.
  'phone',
  // Contact emails: only for callers allowed to contact businesses (`outreach:send`).
  'email',
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];
export const CONTACT_EXPORT_FIELDS: ReadonlySet<ExportField> = new Set(['email']);

/** `GET /v1/businesses/export.csv`: the listing's filters and sort, the columns, and the category label language. */
export const BusinessExportQuerySchema = BusinessFiltersSchema.extend({
  sort: BusinessSearchQuerySchema.shape.sort,
  fields: many(z.enum(EXPORT_FIELDS), EXPORT_FIELDS.length).describe(
    'Columns, in order. Default: every column the caller may export (`email` needs `outreach:send`).',
  ),
  lang: z.enum(['en', 'fr']).default('en').describe('Language of category labels.'),
});
export type BusinessExportQuery = z.output<typeof BusinessExportQuerySchema>;

export const BusinessListItemSchema = BusinessSummarySchema.extend({
  score: z.number().int().nullable(),
  tier: ScoreTierSchema.nullable(),
  tags: z.array(z.string()),
  ownerUserId: z.uuid().nullable(),
  trackedAt: IsoDateTimeSchema,
  lastActivityAt: IsoDateTimeSchema.nullable(),
  distanceMeters: z.number().nullable().describe('From `near` or the area centre; null otherwise.'),
  hasEmail: z.boolean().describe('Whether an email contact is known (the address itself is not listed).'),
  addedVia: AddedViaSchema,
  enrichment: z
    .object({ status: EnrichmentListingStatusSchema, finishedAt: IsoDateTimeSchema.nullable() })
    .describe("This workspace's latest enrichment run of the business (BF-027)."),
}).meta({ id: 'BusinessListItem' });
export type BusinessListItem = z.infer<typeof BusinessListItemSchema>;

export const BusinessSearchPageSchema = cursorPage(BusinessListItemSchema).meta({ id: 'BusinessSearchPage' });
export type BusinessSearchPage = z.infer<typeof BusinessSearchPageSchema>;

const FacetCountSchema = z.object({ value: z.string(), count: z.number().int().nonnegative() });

export const CategoryFacetSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  labels: z.object({ en: z.string(), fr: z.string() }),
  parentId: z.uuid().nullable(),
  count: z.number().int().nonnegative(),
});

export const RATING_BANDS = ['none', 'lt3', '3to4', '4to4.5', 'gte4.5'] as const;

/**
 * Counts per dimension under the same filters, each dimension ignoring its own filter (standard faceting): picking
 * a status keeps the other statuses' counts visible. With text (`q`/`keyword`), counts cover the ranked results.
 */
export const BusinessFacetsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    categories: z
      .array(CategoryFacetSchema)
      .describe('Top-level categories, plus children of selected ones.'),
    pipelineStatuses: z.array(FacetCountSchema),
    tiers: z.array(FacetCountSchema).describe('`none` for unscored businesses.'),
    website: z.array(FacetCountSchema).describe('`has` / `none`.'),
    email: z.array(FacetCountSchema).describe('`has` / `none`.'),
    ratingBands: z.array(FacetCountSchema).describe(`One of ${RATING_BANDS.join(', ')}.`),
    localities: z.array(FacetCountSchema).describe('Top 20.'),
  })
  .meta({ id: 'BusinessFacets' });
export type BusinessFacets = z.infer<typeof BusinessFacetsSchema>;

/**
 * `search.embed-business`: embeds one business whose embedding text or the configured model changed (BF-022).
 * Idempotency key `businessId:model:textHash`, so repeated updates with the same text collapse.
 */
export const SearchEmbedBusinessJob = defineJob('search', 'embed-business', { businessId: BusinessId });
