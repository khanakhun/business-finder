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
  OVERPASS_URL: z
    .url()
    .default('https://overpass-api.de/api/interpreter')
    .describe(
      'Overpass API endpoint. The public one is for light use: self-host or use a paid instance in production.',
    ),
  OVERPASS_REQUESTS_PER_SECOND: z.coerce
    .number()
    .positive()
    .max(10)
    .default(0.1)
    .describe(
      'Overpass calls per second (no parallel queries on public instances; raise for a self-hosted one).',
    ),
  OVERPASS_CONTACT_EMAIL: z
    .email()
    .optional()
    .describe('Contact address in the Overpass User-Agent (usage policy: identify the application).'),
  MAPS_SCRAPER_URL: z
    .url()
    .optional()
    .describe('Self-hosted gosom/google-maps-scraper web API (only used with FEATURE_MAPS_SCRAPER).'),
  MAPS_SCRAPER_MAX_TIME_SECONDS: z.coerce
    .number()
    .int()
    .min(180)
    .max(3_600)
    .default(300)
    .describe('Time budget of one scraper job (the scraper needs at least 3 minutes).'),
});
