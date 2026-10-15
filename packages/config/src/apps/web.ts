import { z } from 'zod';
import { coreEnv } from '../fragments/core.ts';
import { port } from '../schema.ts';

/** Variables inlined into the browser bundle. Only `NEXT_PUBLIC_*`, never secrets (enforced by tests). */
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
});

export const webEnv = z.object({
  NODE_ENV: coreEnv.shape.NODE_ENV,
  LOG_LEVEL: coreEnv.shape.LOG_LEVEL,
  APP_URL: coreEnv.shape.APP_URL,
  API_URL: coreEnv.shape.API_URL,
  WEB_PORT: port(3000).describe('HTTP port of apps/web. Set by infra:up from BF_PORT_OFFSET.'),
  ...webPublicEnv.shape,
});
export type WebEnv = z.output<typeof webEnv>;
