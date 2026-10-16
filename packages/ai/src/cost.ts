import { z } from 'zod';

/** USD per million tokens, per model id (config `AI_PRICING`; update when providers change prices). */
export const ModelPricingSchema = z.record(
  z.string(),
  z.object({
    inputPerMTok: z.number().nonnegative(),
    outputPerMTok: z.number().nonnegative(),
    /** Price of cache reads, when the provider bills them differently. */
    cachedInputPerMTok: z.number().nonnegative().optional(),
  }),
);
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Part of `inputTokens` read from the provider's prompt cache. */
  readonly cachedTokens: number;
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}

/** Cost of one call, or null when the model has no price configured (the ledger keeps tokens either way). */
export function costUsd(pricing: ModelPricing, model: string, usage: TokenUsage): number | null {
  const price = pricing[model];
  if (!price) return null;
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const cachedPrice = price.cachedInputPerMTok ?? price.inputPerMTok;
  const total =
    ((usage.inputTokens - cached) * price.inputPerMTok +
      cached * cachedPrice +
      usage.outputTokens * price.outputPerMTok) /
    1_000_000;
  // numeric(12,6) in the ledger.
  return Math.round(total * 1_000_000) / 1_000_000;
}
