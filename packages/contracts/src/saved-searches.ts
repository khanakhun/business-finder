import { z } from 'zod';
import { BUSINESS_SORTS, BusinessFiltersSchema } from './business-search.ts';
import { CursorPageRequestSchema, cursorPage } from './pagination.ts';
import { SearchIntentSchema } from './search-intent.ts';
import { IsoDateTimeSchema } from './time.ts';

// Saved searches and lists (BF-022): workspace-scoped, built on the listing filters.

const FILTER_KEYS = new Set(Object.keys(BusinessFiltersSchema.shape));

/**
 * Listing filters in query-string form, exactly as `GET /v1/businesses` takes them (so the dashboard can replay them
 * as a URL); validated against the listing's filter schema.
 */
export const SavedFiltersSchema = z
  .record(z.string().max(40), z.union([z.string().max(500), z.array(z.string().max(500)).max(50)]))
  .superRefine((filters, ctx) => {
    const unknown = Object.keys(filters).filter((key) => !FILTER_KEYS.has(key));
    if (unknown.length > 0)
      ctx.addIssue({ code: 'custom', message: `Unknown filters: ${unknown.join(', ')}` });
    const parsed = BusinessFiltersSchema.safeParse(filters);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  });
export type SavedFilters = z.infer<typeof SavedFiltersSchema>;

export const SAVED_SEARCH_VISIBILITIES = ['private', 'workspace'] as const;
const VisibilitySchema = z.enum(SAVED_SEARCH_VISIBILITIES);
const NameSchema = z.string().trim().min(1).max(120);

export const SavedSearchSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    prompt: z.string().nullable(),
    intent: SearchIntentSchema.nullable(),
    filters: SavedFiltersSchema,
    sort: z.enum(BUSINESS_SORTS).nullable(),
    visibility: VisibilitySchema,
    notifyNew: z.boolean(),
    lastRunAt: IsoDateTimeSchema.nullable(),
    newMatches: z
      .number()
      .int()
      .nonnegative()
      .describe('Businesses matching now that were tracked after `lastRunAt` (all matches if never run).'),
    createdBy: z.uuid().nullable(),
    mine: z.boolean().describe('Whether the caller created it (only the creator may change it).'),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'SavedSearch' });
export type SavedSearch = z.infer<typeof SavedSearchSchema>;

export const SavedSearchPageSchema = cursorPage(SavedSearchSchema).meta({ id: 'SavedSearchPage' });
export type SavedSearchPage = z.infer<typeof SavedSearchPageSchema>;

export const CreateSavedSearchRequestSchema = z
  .object({
    name: NameSchema,
    prompt: z.string().trim().min(1).max(500).optional(),
    intent: SearchIntentSchema.optional(),
    filters: SavedFiltersSchema.default({}),
    sort: z.enum(BUSINESS_SORTS).optional(),
    visibility: VisibilitySchema.default('private'),
    notifyNew: z.boolean().default(false),
  })
  .meta({ id: 'CreateSavedSearchRequest' });
export type CreateSavedSearchRequest = z.output<typeof CreateSavedSearchRequestSchema>;

export const UpdateSavedSearchRequestSchema = z
  .object({
    name: NameSchema,
    prompt: z.string().trim().min(1).max(500).nullable(),
    intent: SearchIntentSchema.nullable(),
    filters: SavedFiltersSchema,
    sort: z.enum(BUSINESS_SORTS).nullable(),
    visibility: VisibilitySchema,
    notifyNew: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update' })
  .meta({ id: 'UpdateSavedSearchRequest' });
export type UpdateSavedSearchRequest = z.output<typeof UpdateSavedSearchRequestSchema>;

export const SavedSearchQuerySchema = CursorPageRequestSchema;

// --- Lists ------------------------------------------------------------------------------------------------------

export const BusinessListSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    itemCount: z.number().int().nonnegative(),
    createdBy: z.uuid().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'BusinessList' });
export type BusinessList = z.infer<typeof BusinessListSchema>;

export const BusinessListPageSchema = cursorPage(BusinessListSchema).meta({ id: 'BusinessListPage' });
export type BusinessListPage = z.infer<typeof BusinessListPageSchema>;

export const CreateListRequestSchema = z.object({
  name: NameSchema,
  description: z.string().trim().max(1_000).optional(),
});
export type CreateListRequest = z.output<typeof CreateListRequestSchema>;

export const UpdateListRequestSchema = z
  .object({ name: NameSchema, description: z.string().trim().max(1_000).nullable() })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update' });
export type UpdateListRequest = z.output<typeof UpdateListRequestSchema>;

/** Bulk add/remove: at most 1,000 businesses per call; only businesses the workspace tracks can be added. */
export const ListItemsRequestSchema = z.object({
  businessIds: z.array(z.uuid()).min(1).max(1_000),
});
export type ListItemsRequest = z.output<typeof ListItemsRequestSchema>;

export const ListItemsResultSchema = z
  .object({
    changed: z.number().int().nonnegative().describe('Added (or removed) by this call.'),
    unchanged: z.number().int().nonnegative().describe('Already in (or not in) the list.'),
    notTracked: z.array(z.uuid()).describe('Ids the workspace does not track (not added).'),
    itemCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'ListItemsResult' });
export type ListItemsResult = z.infer<typeof ListItemsResultSchema>;
