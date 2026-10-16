import { z } from 'zod';
import { coreEnv } from '../fragments/core.ts';
import { sitesDbEnv } from '../fragments/db.ts';
import { sitesApiEnv } from '../fragments/sites.ts';
import { port } from '../schema.ts';

// The renderer (BF-036) reads published sites with the read-only role and shares two secrets with the API (signed
// revalidation calls, view-beacon tokens). It holds no write credential of any kind: no S3 keys, no API secrets.
export const sitesEnv = z.object({
  ...coreEnv.shape,
  ...sitesDbEnv.shape,
  ...sitesApiEnv.pick({
    SITES_REVALIDATE_SECRET: true,
    SITES_VIEW_TOKEN_SECRET: true,
    SITES_ASSETS_BASE_URL: true,
  }).shape,
  SITES_PORT: port(3100).describe('HTTP port of apps/sites. Set by infra:up from BF_PORT_OFFSET.'),
  SITES_CLAIM_URL: z
    .url()
    .optional()
    .describe(
      'Where a preview\'s "This is my business" button leads (the claim form, BF-048); unset: no button.',
    ),
  SITES_OPT_OUT_URL: z
    .url()
    .optional()
    .describe(
      'Where a preview\'s "Not interested" button leads (opt-out, BF-055; the e-mail\'s signed ?r= token is passed on); unset: no button.',
    ),
});
export type SitesEnv = z.output<typeof sitesEnv>;
