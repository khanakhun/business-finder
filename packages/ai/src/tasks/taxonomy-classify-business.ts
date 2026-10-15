import { z } from 'zod';
import { defineTask } from '../define-task.ts';
import { untrusted } from '../untrusted.ts';

// LLM fallback of the category classifier (BF-015): picks among candidate categories retrieved for the business,
// never outside them. Callers must still check the answer against the candidates they sent.

export const ClassifyBusinessInput = z.object({
  name: z.string().min(1).max(200),
  providerCategories: z
    .array(
      z.object({
        provider: z.string().min(1).max(40),
        key: z.string().min(1).max(200),
        label: z.string().max(200).optional(),
      }),
    )
    .max(20)
    .default([]),
  /** A short excerpt of the business's website (untrusted). */
  websiteSnippet: z.string().max(2_000).optional(),
  locale: z.enum(['en', 'fr']),
  /** Our categories to choose from (ids are slugs), most similar first. */
  candidates: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_]{1,40}$/),
        label: z.string().min(1).max(200),
        path: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(20),
});
export type ClassifyBusinessInput = z.input<typeof ClassifyBusinessInput>;

/** `none` when no candidate fits. */
export const NO_CATEGORY = 'none';

export const ClassifyBusinessOutput = z.object({
  primary: z.string().describe(`The id of the best-fitting candidate, or "${NO_CATEGORY}" when none fits.`),
  secondary: z
    .array(z.string())
    .max(3)
    .describe('Up to 3 other candidate ids that also clearly apply (e.g. a bar that is also a restaurant).'),
  confidence: z.number().min(0).max(1).describe('How sure you are about `primary` (0–1).'),
  rationale: z.string().max(400).describe('One short sentence explaining the choice, for a human reviewer.'),
});
export type ClassifyBusinessOutput = z.infer<typeof ClassifyBusinessOutput>;

export const TaxonomyClassifyBusiness = defineTask({
  name: 'taxonomy.classify_business',
  kind: 'object',
  tier: 'fast',
  prompt: 'taxonomy.classify_business.v1',
  input: ClassifyBusinessInput,
  output: ClassifyBusinessOutput,
  temperature: 0,
  maxOutputTokens: 300,
  timeoutMs: 20_000,
  cacheTtlSeconds: 30 * 24 * 3600,
  // Same business facts and candidates give the same answer for every workspace.
  cacheScope: 'global',
  evalSet: 'taxonomy.classify_business',
  variables: (input) => ({
    candidates: input.candidates.map((c) => `- ${c.id}: ${c.label} (${c.path})`).join('\n'),
    locale: input.locale,
    // Names, provider categories and site text come from providers and crawls: untrusted.
    name: untrusted('provider:name', input.name, { maxChars: 200, id: 'name' }),
    providerCategories: untrusted(
      'provider:categories',
      input.providerCategories.length > 0
        ? input.providerCategories
            .map((c) => `${c.provider}: ${c.key}${c.label ? ` (${c.label})` : ''}`)
            .join('\n')
        : '(none)',
      { maxChars: 1_000, id: 'provider_categories' },
    ),
    website: untrusted('website:snippet', input.websiteSnippet ?? '(none)', {
      maxChars: 1_500,
      id: 'website',
    }),
  }),
});
