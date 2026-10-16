import { z } from 'zod';
import { secret } from '../schema.ts';

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
  ENRICHMENT_VISION_AUDIT_COST_USD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.02)
    .describe('Estimated cost of one visual audit (smart-tier vision model, two screenshots), for budgets.'),
  PAGESPEED_RATE_PER_MINUTE: z.coerce
    .number()
    .int()
    // Each audit takes two runs (mobile and desktop) at once.
    .min(2)
    .max(10_000)
    .default(200)
    .describe('PageSpeed Insights runs per minute per key (Google default: 400 per 100 s; keep headroom).'),
  PAGESPEED_DAILY_QUOTA: z.coerce
    .number()
    .int()
    .min(2)
    .max(10_000_000)
    .default(24_000)
    .describe('PageSpeed Insights runs per day per key (Google default: 25,000 per project).'),
  ENRICHMENT_REVIEWS_LLM_COST_USD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.002)
    .describe('Estimated LLM cost of classifying one business’s reviews (fast tier), for budgets.'),
  ENRICHMENT_REVIEWS_GOOGLE_COST_USD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.025)
    .describe(
      'Cost of one Google Place Details call with reviews (Enterprise + Atmosphere SKU), for budgets.',
    ),
  REACHER_URL: z
    .url()
    .optional()
    .describe(
      'Self-hosted Reacher backend (compose profile `verify`; needs outbound port 25). Unset: skipped.',
    ),
  REACHER_HEADER_SECRET: secret(
    z
      .string()
      .min(32)
      .optional()
      .describe('Shared secret Reacher requires in `x-reacher-secret` (its `RCH__HEADER_SECRET`).'),
  ),
  ENRICHMENT_EMAIL_VERIFY_COST_USD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.008)
    .describe('Estimated cost of one commercial e-mail verification (ZeroBounce), for budgets.'),
  EMAIL_VERIFY_PER_MAIL_SERVER_PER_MINUTE: z.coerce
    .number()
    .positive()
    .max(60)
    .default(6)
    .describe(
      'Mailbox checks per mail server per minute, all workspaces together (one workspace gets half); politeness.',
    ),
  EMAIL_VERIFY_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(32)
    .default(4)
    .describe('SMTP mailbox checks (Reacher) running at once per worker process.'),
  ENRICHMENT_REFRESH_HOUR_UTC: z.coerce
    .number()
    .int()
    .min(0)
    .max(23)
    .default(3)
    .describe('Hour (UTC) of the nightly refresh of stale enrichment.'),
});
