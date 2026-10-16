import { z } from 'zod';
import { LocaleSchema } from './i18n.ts';
import { defineJob } from './jobs.ts';
import { IsoDateTimeSchema } from './time.ts';

// Category taxonomy (BF-015): our bilingual tree of business categories and how provider categories map onto it.

/** What we sell (DOMAIN.md): scoring profiles are per offer; categories weigh how relevant each one is. */
export const OFFERS = [
  'new_website',
  'website_redesign',
  'ai_receptionist',
  'booking_system',
  'local_seo',
] as const;
export const OfferSchema = z.enum(OFFERS);
export type Offer = z.infer<typeof OfferSchema>;

export const CATEGORY_ATTRIBUTES = [
  'appointmentBased',
  'hospitality',
  'retail',
  'regulated',
  'tourismFacing',
] as const;
export const CategoryAttributesSchema = z
  .partialRecord(z.enum(CATEGORY_ATTRIBUTES), z.boolean())
  .meta({ id: 'CategoryAttributes' });
export type CategoryAttributes = z.infer<typeof CategoryAttributesSchema>;

export const OfferRelevanceSchema = z
  .partialRecord(OfferSchema, z.number().min(0).max(1))
  .meta({ id: 'OfferRelevance', description: 'Relevance of each offer to the category (0–1).' });
export type OfferRelevance = z.infer<typeof OfferRelevanceSchema>;

export const CategoryLabelsSchema = z.object({ en: z.string().min(1), fr: z.string().min(1) });
export const CategorySynonymsSchema = z.object({
  en: z.array(z.string().min(1)).default([]),
  fr: z.array(z.string().min(1)).default([]),
});

/** One node of the tree (`GET /v1/categories`), with its children. */
export interface CategoryNode {
  id: string;
  slug: string;
  path: string;
  label: string;
  labels: { en: string; fr: string };
  icon: string | null;
  attributes: CategoryAttributes;
  children: CategoryNode[];
}
export const CategoryNodeSchema: z.ZodType<CategoryNode> = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    path: z.string().describe('Dotted slugs from the root, e.g. `food_drink.cafe`.'),
    label: z.string().describe('In the requested locale.'),
    labels: CategoryLabelsSchema,
    icon: z.string().nullable().describe('Tabler icon name.'),
    attributes: CategoryAttributesSchema,
    get children() {
      return z.array(CategoryNodeSchema);
    },
  })
  .meta({ id: 'CategoryNode' });

export const CategoryTreeQuerySchema = z.object({ locale: LocaleSchema.default('en') });
export const CategoryTreeSchema = z
  .object({ version: z.number().int(), items: z.array(CategoryNodeSchema) })
  .meta({ id: 'CategoryTree' });
export type CategoryTree = z.infer<typeof CategoryTreeSchema>;

export const CategorySearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  locale: LocaleSchema.default('en'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type CategorySearchQuery = z.infer<typeof CategorySearchQuerySchema>;

export const CategorySearchHitSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    path: z.string(),
    label: z.string(),
    /** Labels of the ancestors, root first (for "Food & drink › Café"). */
    breadcrumb: z.array(z.string()),
    score: z.number().describe('Higher is better; comparable only within one response.'),
  })
  .meta({ id: 'CategorySearchHit' });
export const CategorySearchResultSchema = z
  .object({ items: z.array(CategorySearchHitSchema) })
  .meta({ id: 'CategorySearchResult' });
export type CategorySearchResult = z.infer<typeof CategorySearchResultSchema>;

/** Providers whose categories map onto the taxonomy. */
export const TAXONOMY_PROVIDERS = ['google_places', 'overture', 'foursquare', 'osm'] as const;
export const TaxonomyProviderSchema = z.enum(TAXONOMY_PROVIDERS);
export type TaxonomyProvider = z.infer<typeof TaxonomyProviderSchema>;

export const MAPPING_ORIGINS = ['seed', 'llm', 'human'] as const;
export const MappingOriginSchema = z.enum(MAPPING_ORIGINS);
export type MappingOrigin = z.infer<typeof MappingOriginSchema>;

export const MAPPING_STATUSES = ['active', 'needs_review', 'rejected'] as const;
export const MappingStatusSchema = z.enum(MAPPING_STATUSES);
export type MappingStatus = z.infer<typeof MappingStatusSchema>;

export const CategoryMappingSchema = z
  .object({
    id: z.uuid(),
    provider: TaxonomyProviderSchema,
    providerKey: z.string(),
    providerLabel: z.string().nullable(),
    categoryId: z.uuid(),
    categorySlug: z.string(),
    categoryLabel: z.string(),
    confidence: z.number().min(0).max(1),
    origin: MappingOriginSchema,
    status: MappingStatusSchema,
    rationale: z.string().nullable().describe('Why the model proposed it (LLM mappings).'),
    createdAt: IsoDateTimeSchema,
    reviewedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'CategoryMapping' });
export type CategoryMapping = z.infer<typeof CategoryMappingSchema>;

export const CategoryMappingQuerySchema = z.object({
  status: MappingStatusSchema.default('needs_review'),
  provider: TaxonomyProviderSchema.optional(),
  locale: LocaleSchema.default('en'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type CategoryMappingQuery = z.infer<typeof CategoryMappingQuerySchema>;

export const CategoryMappingPageSchema = z
  .object({
    items: z.array(CategoryMappingSchema),
    nextCursor: z.string().nullable(),
    canReview: z
      .boolean()
      .describe(
        'Mappings are shared by every workspace: only platform operators approve, reassign or reject.',
      ),
  })
  .meta({ id: 'CategoryMappingPage' });
export type CategoryMappingPage = z.infer<typeof CategoryMappingPageSchema>;

/** `PATCH /v1/categories/mappings/:id`: approve, point to another category, or reject. */
export const ReviewCategoryMappingRequestSchema = z
  .object({
    action: z.enum(['approve', 'reassign', 'reject']),
    categoryId: z.uuid().optional().describe('The new category (`reassign` only).'),
  })
  .refine((body) => (body.action === 'reassign') === (body.categoryId !== undefined), {
    message: '`categoryId` is required for `reassign` and only allowed there',
    path: ['categoryId'],
  })
  .meta({ id: 'ReviewCategoryMappingRequest' });
export type ReviewCategoryMappingRequest = z.infer<typeof ReviewCategoryMappingRequestSchema>;

/** `taxonomy.embed-categories`: embeds categories whose labels/synonyms or the embedding model changed. */
export const TaxonomyEmbedCategoriesJob = defineJob('taxonomy', 'embed-categories', {
  reason: z.enum(['startup', 'manual']).describe('What triggered the run (logs only).'),
});
