import { z } from 'zod';
import { secret } from '../schema.ts';

/** The API's side of the site platform (BF-035): the renderer it refreshes and the asset host sites may use. */
export const sitesApiEnv = z.object({
  SITES_INTERNAL_URL: z
    .url()
    .default('http://127.0.0.1:3100')
    .describe('Internal URL of apps/sites; the API asks it to refresh a site after a publication changes.'),
  SITES_REVALIDATE_SECRET: secret(
    z
      .string()
      .min(32)
      .optional()
      .describe(
        'Shared secret signing revalidation calls to apps/sites, ≥ 32 chars. Unset: no revalidation (refused in production).',
      ),
  ),
  SITES_ASSETS_BASE_URL: z
    .url()
    .default('https://assets.sites.localhost')
    .describe(
      'Public base URL of site images (CDN in front of the sites bucket); its host is the only asset host.',
    ),
  // BF-062: custom domains of live sites.
  SITES_INGRESS_IPS: z
    .string()
    .default('')
    .describe(
      "Comma-separated public IPs of the sites ingress: what an apex domain's A/AAAA records must point to (custom domains).",
    ),
  DOMAIN_ASK_TOKEN: secret(
    z
      .string()
      .min(32)
      .optional()
      .describe(
        "Token in Caddy's on-demand TLS `ask` URL (?token=), ≥ 32 chars: certificates are issued only for verified domains. Unset: every ask is refused.",
      ),
  ),
  LEADS_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3_650)
    .default(730)
    .describe(
      'Days a preview lead (claim, contact request, opt-out) is kept (BF-048; 24 months by default).',
    ),
  LEADS_SPAM_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .describe('Days a lead marked as spam is kept (BF-048).'),
  SITE_CHAT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3_650)
    .default(180)
    .describe('Days a site chat thread (messages and proposals) is kept after its last message (BF-047).'),
  SITES_VIEW_TOKEN_SECRET: secret(
    z
      .string()
      .min(32)
      .optional()
      .describe(
        'Shared with apps/sites: signs the view-beacon token of published pages and salts the daily visitor hashes, ≥ 32 chars. Unset: views are not counted (refused in production).',
      ),
  ),
});
