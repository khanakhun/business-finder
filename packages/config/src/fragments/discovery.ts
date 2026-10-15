import { z } from 'zod';
import { booleanFlag } from '../schema.ts';

/** Discovery providers (BF-018): metering and client-side rate limits. Keys live in the secrets vault. */
export const discoveryEnv = z.object({
  DISCOVERY_APPLY_FREE_TIER: booleanFlag(true).describe(
    "Count providers' free monthly allowances (per billing account) before estimating cost.",
  ),
  GOOGLE_PLACES_REQUESTS_PER_SECOND: z.coerce
    .number()
    .positive()
    .max(100)
    .default(5)
    .describe('Client-side cap on Google Places calls per second, per API key (Google allows ~100/s).'),
});
