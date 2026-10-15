import {
  PAIN_SIGNALS,
  PIPELINE_STATUSES,
  SCORE_TIERS,
  SEARCH_MODES,
  SEARCH_SORT_FIELDS,
  WEBSITE_FILTERS,
} from '@bf/contracts';
import { z } from 'zod';
import { defineTask } from '../define-task.ts';

// Natural-language search → structured intent (BF-021). The model picks categories only among the candidates it is
// given (callers re-check), copies the location phrase verbatim (the geo module resolves it) and maps filters to
// fixed enums. Every field is required (nullable when unknown) so strict structured-output modes accept the schema.

export const ParseSearchIntentInput = z.object({
  /** The user's request (trusted, but length-limited). */
  prompt: z.string().min(1).max(500),
  /** Language the request is written in (detected by the caller). */
  language: z.enum(['en', 'fr']),
  /** The workspace's default country (ISO 3166-1 alpha-2), for interpreting place names. */
  defaultCountry: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  /** Our categories to choose from (ids are slugs), most similar first. */
  candidates: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_]{1,40}$/),
        labelEn: z.string().min(1).max(200),
        labelFr: z.string().min(1).max(200),
        path: z.string().min(1).max(300),
      }),
    )
    .max(20),
});
export type ParseSearchIntentInput = z.input<typeof ParseSearchIntentInput>;

const nullableNumber = (description: string) => z.number().nullable().describe(description);
const nullableBoolean = (description: string) => z.boolean().nullable().describe(description);

export const ParseSearchIntentOutput = z.object({
  mode: z
    .enum(SEARCH_MODES)
    .describe(
      '"listings" when the user filters businesses already in their workspace ("my qualified spas"); ' +
        '"discover" when they explicitly ask for new businesses only; otherwise "both".',
    ),
  categoryIds: z
    .array(z.string())
    .max(10)
    .describe('Ids of the candidate categories the request asks for; [] when none fits.'),
  keywords: z
    .array(z.string())
    .max(10)
    .describe('Short terms the categories do not capture ("vegan", "rooftop"), in the request language.'),
  locationText: z
    .string()
    .nullable()
    .describe(
      'The location phrase copied verbatim from the request ("Gustavia", "1017 AB"); null when none.',
    ),
  filters: z.object({
    website: z
      .enum(WEBSITE_FILTERS)
      .describe('"none": no website; "has": has one; "weak": slow/outdated site.'),
    minRating: nullableNumber('Minimum review rating (1–5), e.g. "at least 4 stars" → 4.'),
    maxRating: nullableNumber('Maximum review rating (1–5), e.g. "rated below 4" → 4.'),
    minReviews: nullableNumber('Minimum number of reviews, e.g. "more than 50 reviews" → 51.'),
    maxReviews: nullableNumber('Maximum number of reviews, e.g. "fewer than 20 reviews" → 19.'),
    hasEmail: nullableBoolean('true when an email address is required, false when it must be missing.'),
    hasPhone: nullableBoolean('true when a phone number is required, false when it must be missing.'),
    emailVerified: nullableBoolean('true when the email must be verified/deliverable.'),
    languages: z.array(z.string()).describe('Website languages asked for, ISO 639-1 ("en", "fr").'),
    priceLevels: z.array(z.number()).describe('Price levels 1 (cheap) to 4 (luxury).'),
    painSignals: z.array(z.enum(PAIN_SIGNALS)).describe('Problems the businesses should show.'),
    minScore: nullableNumber('Minimum opportunity score (0–100).'),
    tiers: z.array(z.enum(SCORE_TIERS)).describe('Opportunity tiers: A (act now), B, C, X (gated out).'),
    pipelineStatuses: z.array(z.enum(PIPELINE_STATUSES)).describe('Pipeline statuses ("my qualified …").'),
    tags: z.array(z.string()).describe('Workspace tags named explicitly ("tagged vip" → "vip").'),
    addedWithinDays: nullableNumber('Only businesses added in the last N days ("added this week" → 7).'),
  }),
  sort: z.object({
    field: z.enum(SEARCH_SORT_FIELDS).describe('"relevance" unless the request asks for an order.'),
    direction: z.enum(['asc', 'desc']),
  }),
  limit: nullableNumber('How many results the user wants ("find 50 cafés" → 50); null when not said.'),
  needsClarification: z
    .object({
      question: z.string().describe('One short question, in the request language.'),
      options: z.array(z.string()).max(6).describe('Possible answers; [] when open.'),
    })
    .nullable()
    .describe('Only when two very different readings exist; otherwise null.'),
  confidence: z.number().min(0).max(1).describe('How sure you are about the whole reading (0–1).'),
  warnings: z.array(z.string()).max(5).describe('Short notes on what you could not map; [] usually.'),
});
export type ParseSearchIntentOutput = z.infer<typeof ParseSearchIntentOutput>;

export const SearchParseIntent = defineTask({
  name: 'search.parse_intent',
  kind: 'object',
  tier: 'smart',
  prompt: 'search.parse_intent.v1',
  input: ParseSearchIntentInput,
  output: ParseSearchIntentOutput,
  temperature: 0,
  maxOutputTokens: 1_500,
  timeoutMs: 20_000,
  cacheTtlSeconds: 3_600,
  evalSet: 'search.parse_intent',
  variables: (input) => ({
    prompt: input.prompt,
    language: input.language,
    defaultCountry: input.defaultCountry ?? 'unknown',
    candidates:
      input.candidates.length > 0
        ? input.candidates.map((c) => `- ${c.id}: ${c.labelEn} / ${c.labelFr} (${c.path})`).join('\n')
        : '(none)',
  }),
});
