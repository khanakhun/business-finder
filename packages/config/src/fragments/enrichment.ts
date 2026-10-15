import { z } from 'zod';

const ttlDays = (days: number, step: string) =>
  z.coerce.number().int().min(1).max(365).default(days).describe(`Days a ${step} result stays fresh.`);

/** Enrichment (BF-027): freshness per step, cost estimates, nightly refresh. Budgets are workspace settings. */
export const enrichmentEnv = z.object({
  ENRICHMENT_TTL_SITE_INTEL_DAYS: ttlDays(30, 'website crawl (site intel)'),
  ENRICHMENT_TTL_EMAIL_VERIFY_DAYS: ttlDays(60, 'e-mail verification'),
  ENRICHMENT_TTL_REVIEWS_DAYS: ttlDays(30, 'reviews analysis'),
  ENRICHMENT_TTL_PSI_DAYS: ttlDays(30, 'PageSpeed'),
  ENRICHMENT_TTL_VISION_AUDIT_DAYS: ttlDays(30, 'visual audit'),
  ENRICHMENT_SITE_INTEL_COST_USD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Estimated cost of one website crawl, counted against enrichment budgets (self-hosted: 0).'),
  ENRICHMENT_REFRESH_HOUR_UTC: z.coerce
    .number()
    .int()
    .min(0)
    .max(23)
    .default(3)
    .describe('Hour (UTC) of the nightly refresh of stale enrichment.'),
});
