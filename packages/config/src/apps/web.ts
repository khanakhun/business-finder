import { z } from 'zod';
import { coreEnv } from '../fragments/core.ts';
import { port } from '../schema.ts';

/**
 * Public URLs the browser needs. Read by the web server at run time and embedded in each page (one image serves
 * every environment, BF-025). Only `NEXT_PUBLIC_*`, never secrets (enforced by tests).
 */
export const webPublicEnv = z.object({
  NEXT_PUBLIC_API_URL: z.url().default('http://localhost:4000').describe('API base URL used by the browser.'),
  NEXT_PUBLIC_APP_URL: z
    .url()
    .default('http://localhost:3000')
    .describe('Dashboard URL used by the browser.'),
  NEXT_PUBLIC_MAP_STYLE_URL: z
    .url()
    .default('https://tiles.openfreemap.org/styles/liberty')
    .describe('MapLibre style for the search map (OpenFreeMap by default: free, no key, OSM attribution).'),
  NEXT_PUBLIC_SITES_ASSETS_BASE_URL: z
    .url()
    .default('https://assets.sites.localhost')
    .describe("Public base URL of site images (SITES_ASSETS_BASE_URL): the site editor's canvas shows them."),
});

export const webEnv = z.object({
  NODE_ENV: coreEnv.shape.NODE_ENV,
  LOG_LEVEL: coreEnv.shape.LOG_LEVEL,
  APP_URL: coreEnv.shape.APP_URL,
  API_URL: coreEnv.shape.API_URL,
  API_INTERNAL_URL: z
    .url()
    .optional()
    .describe(
      'The API as the web server reaches it (internal network, e.g. http://api:4000). Default: API_URL.',
    ),
  WEB_PORT: port(3000).describe('HTTP port of apps/web. Set by infra:up from BF_PORT_OFFSET.'),
  ...webPublicEnv.shape,
});
export type WebEnv = z.output<typeof webEnv>;
