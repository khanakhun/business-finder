import { z } from 'zod';
import { PipelineStatusSchema } from './business.ts';
import { AreaCandidateSchema, LocationResolutionSchema } from './geo-areas.ts';
import { LocaleSchema } from './i18n.ts';

// Search intent (BF-021, DOMAIN.md glossary): the structured reading of a natural-language prompt, shown to the
// user as editable chips. A pure description: translating it into a query is BF-022's job.

export const SEARCH_MODES = ['listings', 'discover', 'both'] as const;
export const SearchModeSchema = z
  .enum(SEARCH_MODES)
  .describe('`listings`: filter businesses already found; `discover`: find new ones; `both`.');
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const WEBSITE_FILTERS = ['any', 'none', 'has', 'weak'] as const;
export const WebsiteFilterSchema = z
  .enum(WEBSITE_FILTERS)
  .describe('`weak`: has a site that audits rate poorly (slow, outdated, not mobile friendly).');

/** Pain-signal keys (DOMAIN.md; labels and offer relevance arrive with review mining, BF-029). */
export const PAIN_SIGNALS = [
  'booking_friction',
  'unreachable_by_phone',
  'slow_or_no_reply',
  'website_broken_or_outdated',
  'no_online_menu_or_prices',
  'hard_to_find_info',
  'language_barrier',
  'payment_friction',
  'long_wait_times',
  'inconsistent_hours',
  'poor_communication',
  'positive_strong_reputation',
  'other',
] as const;
export const PainSignalSchema = z.enum(PAIN_SIGNALS);
export type PainSignal = z.infer<typeof PainSignalSchema>;

export const SCORE_TIERS = ['A', 'B', 'C', 'X'] as const;
export const ScoreTierSchema = z.enum(SCORE_TIERS);
export type ScoreTier = z.infer<typeof ScoreTierSchema>;

export const SEARCH_SORT_FIELDS = ['relevance', 'score', 'rating', 'reviews', 'distance', 'recent'] as const;

export const SearchFiltersSchema = z
  .object({
    website: WebsiteFilterSchema.default('any'),
    minRating: z.number().min(1).max(5).nullable().default(null),
    maxRating: z.number().min(1).max(5).nullable().default(null),
    minReviews: z.number().int().min(0).nullable().default(null),
    maxReviews: z.number().int().min(0).nullable().default(null),
    hasEmail: z.boolean().nullable().default(null),
    hasPhone: z.boolean().nullable().default(null),
    emailVerified: z.boolean().nullable().default(null),
    languages: z
      .array(z.string().regex(/^[a-z]{2}$/))
      .max(10)
      .default([])
      .describe('Website languages (ISO 639-1).'),
    priceLevels: z.array(z.number().int().min(1).max(4)).max(4).default([]),
    painSignals: z.array(PainSignalSchema).max(PAIN_SIGNALS.length).default([]),
    scoreProfile: z.string().max(100).nullable().default(null).describe('Scoring profile id or name.'),
    minScore: z.number().int().min(0).max(100).nullable().default(null),
    tiers: z.array(ScoreTierSchema).max(4).default([]),
    pipelineStatuses: z.array(PipelineStatusSchema).max(9).default([]),
    tags: z.array(z.string().min(1).max(50)).max(20).default([]),
    addedWithinDays: z.number().int().min(1).max(3_650).nullable().default(null),
  })
  .meta({ id: 'SearchFilters' });
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

export const SearchIntentSchema = z
  .object({
    mode: SearchModeSchema,
    categories: z.object({
      ids: z.array(z.uuid()).max(20),
      includeDescendants: z
        .boolean()
        .describe('Also match the subcategories (e.g. pizzerias for restaurants).'),
    }),
    keywords: z
      .array(z.string().min(1).max(60))
      .max(10)
      .describe('Terms not covered by a category (e.g. "vegan", "rooftop").'),
    location: z
      .object({
        text: z.string().min(1).max(200).describe('The location phrase as written in the prompt.'),
        resolution: LocationResolutionSchema.nullable(),
      })
      .nullable(),
    filters: SearchFiltersSchema,
    sort: z.object({
      field: z.enum(SEARCH_SORT_FIELDS),
      direction: z.enum(['asc', 'desc']),
    }),
    limit: z.number().int().min(1).max(2_000).nullable().describe('Target result count (discovery).'),
    needsClarification: z
      .object({
        question: z.string().min(1).max(300),
        options: z.array(z.string().min(1).max(200)).max(6).optional(),
      })
      .nullable(),
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string().max(300)).max(10),
    language: LocaleSchema.describe('Language the prompt is written in.'),
  })
  .meta({ id: 'SearchIntent' });
export type SearchIntent = z.infer<typeof SearchIntentSchema>;

export const ParseSearchIntentRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(500),
    locale: LocaleSchema.default('en').describe(
      'UI locale: the default language and the clarification language.',
    ),
  })
  .meta({ id: 'ParseSearchIntentRequest' });
export type ParseSearchIntentRequest = z.infer<typeof ParseSearchIntentRequestSchema>;

export const ParseSearchIntentResponseSchema = z
  .object({
    intent: SearchIntentSchema,
    resolvedArea: AreaCandidateSchema.nullable().describe('The confidently resolved location, if any.'),
    alternatives: z.array(AreaCandidateSchema).describe('Other location candidates (ambiguous locations).'),
  })
  .meta({ id: 'ParseSearchIntentResponse' });
export type ParseSearchIntentResponse = z.infer<typeof ParseSearchIntentResponseSchema>;

/** Warning codes set on intents (machine-readable prefixes; the UI shows localized text). */
export const SEARCH_INTENT_WARNINGS = {
  fallback: 'AI_UNAVAILABLE_FALLBACK',
  invalidCategories: 'CATEGORIES_OUTSIDE_CANDIDATES',
  locationNotFound: 'LOCATION_NOT_FOUND',
  locationIncomplete: 'LOCATION_CANDIDATES_INCOMPLETE',
} as const;
