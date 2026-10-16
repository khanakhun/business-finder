import { apiEnv, workerEnv } from './apps/api.ts';
import { intelServiceEnv } from './apps/intel.ts';
import { sitesEnv } from './apps/sites.ts';
import { webEnv } from './apps/web.ts';
import type { EnvSchema } from './schema.ts';

/** Every deployable's env schema; drives `env:check`, `env:doc` and `env:example`. */
export const APP_SCHEMAS = {
  api: apiEnv,
  worker: workerEnv,
  web: webEnv,
  sites: sitesEnv,
  intel: intelServiceEnv,
} as const satisfies Record<string, EnvSchema>;

export type AppName = keyof typeof APP_SCHEMAS;

export function isAppName(value: string): value is AppName {
  return Object.hasOwn(APP_SCHEMAS, value);
}
