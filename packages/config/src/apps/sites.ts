import { z } from 'zod';
import { coreEnv } from '../fragments/core.ts';
import { sitesDbEnv } from '../fragments/db.ts';
import { s3Env } from '../fragments/s3.ts';
import { port } from '../schema.ts';

export const sitesEnv = z.object({
  ...coreEnv.shape,
  ...sitesDbEnv.shape,
  ...s3Env.shape,
  SITES_PORT: port(3100).describe('HTTP port of apps/sites. Set by infra:up from BF_PORT_OFFSET.'),
});
export type SitesEnv = z.output<typeof sitesEnv>;
