import { z } from 'zod';

/** Geocoding (BF-017). Nominatim's usage policy: ≤ 1 request/s, identifying User-Agent, cached results. */
export const geoEnv = z.object({
  GEOCODER_PROVIDER: z
    .enum(['nominatim', 'google', 'none'])
    .default('nominatim')
    .describe(
      'External geocoder used when an area is not in geo_areas (google uses the google_places secret).',
    ),
  NOMINATIM_BASE_URL: z
    .url()
    .default('https://nominatim.openstreetmap.org')
    .describe('Nominatim endpoint; point it at a self-hosted instance for volume.'),
  GEOCODER_LOOKUPS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .describe('External geocoder lookups each workspace may trigger per minute (cache hits are free).'),
  NOMINATIM_CONTACT_EMAIL: z
    .email()
    .optional()
    .describe(
      'Contact address sent to Nominatim (User-Agent and `email` parameter), required by its policy.',
    ),
});
