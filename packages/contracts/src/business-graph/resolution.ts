import { z } from 'zod';
import { BusinessId } from '../ids.ts';
import { cursorPage } from '../pagination.ts';
import { IsoDateTimeSchema } from '../time.ts';

// Entity resolution APIs (BF-016): explainable match scores, possible duplicates, manual merge and split.

export const MATCH_FEATURES = [
  'name',
  'distance',
  'phone',
  'website',
  'category',
  'address',
  'phoneConflict',
  'websiteConflict',
  'sameProvider',
] as const;
export const MatchFeatureSchema = z.enum(MATCH_FEATURES);
export type MatchFeature = z.infer<typeof MatchFeatureSchema>;

/** Why two records look alike: each feature's raw value (0–1 or metres) and its contribution to the total. */
export const MatchScoreSchema = z
  .object({
    total: z.number().min(0).max(1),
    features: z.array(z.object({ feature: MatchFeatureSchema, value: z.number(), contribution: z.number() })),
    reasons: z.array(z.string()).describe('Human-readable explanations, e.g. "same phone +590590…".'),
  })
  .meta({ id: 'MatchScore' });
export type MatchScore = z.infer<typeof MatchScoreSchema>;

export const DUPLICATE_STATUSES = ['open', 'merged', 'dismissed'] as const;
export const DuplicateStatusSchema = z.enum(DUPLICATE_STATUSES);
export type DuplicateStatus = z.infer<typeof DuplicateStatusSchema>;

export const PossibleDuplicateSchema = z
  .object({
    id: z.uuid(),
    businessA: z.object({ id: BusinessId, displayName: z.string(), locality: z.string().nullable() }),
    businessB: z.object({ id: BusinessId, displayName: z.string(), locality: z.string().nullable() }),
    score: z.number().min(0).max(1),
    reasons: MatchScoreSchema,
    status: DuplicateStatusSchema,
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'PossibleDuplicate' });
export type PossibleDuplicate = z.infer<typeof PossibleDuplicateSchema>;

export const PossibleDuplicateQuerySchema = z.object({
  status: DuplicateStatusSchema.default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type PossibleDuplicateQuery = z.infer<typeof PossibleDuplicateQuerySchema>;

export const PossibleDuplicatePageSchema = cursorPage(PossibleDuplicateSchema).meta({
  id: 'PossibleDuplicatePage',
});
export type PossibleDuplicatePage = z.infer<typeof PossibleDuplicatePageSchema>;

/** `PATCH /v1/businesses/possible-duplicates/:id`: dismiss, or merge (B into A unless `survivorId` says otherwise). */
export const ResolvePossibleDuplicateRequestSchema = z
  .object({
    action: z.enum(['dismiss', 'merge']),
    survivorId: BusinessId.optional().describe('Which of the two businesses survives a merge (default: A).'),
  })
  .meta({ id: 'ResolvePossibleDuplicateRequest' });
export type ResolvePossibleDuplicateRequest = z.infer<typeof ResolvePossibleDuplicateRequestSchema>;

export const MergeBusinessesRequestSchema = z
  .object({
    survivorId: BusinessId,
    mergedIds: z.array(BusinessId).min(1).max(20),
  })
  .refine((body) => !body.mergedIds.includes(body.survivorId), {
    message: 'The survivor cannot be merged into itself',
    path: ['mergedIds'],
  })
  .refine((body) => new Set(body.mergedIds).size === body.mergedIds.length, {
    message: 'Duplicate ids',
    path: ['mergedIds'],
  })
  .meta({ id: 'MergeBusinessesRequest' });
export type MergeBusinessesRequest = z.infer<typeof MergeBusinessesRequestSchema>;

export const MergeBusinessesResultSchema = z
  .object({ survivorId: BusinessId, mergedIds: z.array(BusinessId), sourcesMoved: z.number().int() })
  .meta({ id: 'MergeBusinessesResult' });
export type MergeBusinessesResult = z.infer<typeof MergeBusinessesResultSchema>;

export const SplitBusinessRequestSchema = z
  .object({ sourceIds: z.array(z.uuid()).min(1).max(50) })
  .meta({ id: 'SplitBusinessRequest' });
export type SplitBusinessRequest = z.infer<typeof SplitBusinessRequestSchema>;

export const SplitBusinessResultSchema = z
  .object({ businessId: BusinessId, newBusinessId: BusinessId, sourcesMoved: z.number().int() })
  .meta({ id: 'SplitBusinessResult' });
export type SplitBusinessResult = z.infer<typeof SplitBusinessResultSchema>;
