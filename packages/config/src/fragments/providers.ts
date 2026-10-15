import { z } from 'zod';
import { secret } from '../schema.ts';

/**
 * Deployment-wide provider keys: the fallback for workspaces that have not stored their own in the vault
 * (BF-011, `SECRET_DEFINITIONS[*].globalEnv` in @bf/contracts). ANTHROPIC/OPENAI keys live in the AI group.
 */
export const providersEnv = z.object({
  GOOGLE_PLACES_API_KEY: secret(z.string().min(1).optional().describe('Google Places API key (discovery).')),
  PAGESPEED_API_KEY: secret(z.string().min(1).optional().describe('PageSpeed Insights API key (audits).')),
  FOURSQUARE_API_KEY: secret(z.string().min(1).optional().describe('Foursquare Places API key (discovery).')),
  HF_TOKEN: secret(z.string().min(1).optional().describe('Hugging Face access token.')),
  ZEROBOUNCE_API_KEY: secret(
    z.string().min(1).optional().describe('ZeroBounce API key (e-mail verification without SMTP port 25).'),
  ),
  UNSPLASH_ACCESS_KEY: secret(z.string().min(1).optional().describe('Unsplash access key (stock photos).')),
});
