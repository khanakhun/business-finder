import 'server-only';
import { type SitesEnv, sitesEnv } from '@bf/config/apps/sites';

let cached: SitesEnv | undefined;

/**
 * The renderer's validated environment, from the process environment (scripts/next.mjs loads the repo's .env files
 * for local runs; the container gets real variables). In production both shared secrets are required: without them
 * the API's revalidations would be refused (stale pages) and no view would be counted.
 */
export function sitesEnvironment(): SitesEnv {
  if (cached) return cached;
  // `FOO=` means "not set", so schema defaults and required checks apply.
  const raw = Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => [key, value === '' ? undefined : value]),
  );
  const env = sitesEnv.parse(raw);
  if (env.NODE_ENV === 'production' && (!env.SITES_REVALIDATE_SECRET || !env.SITES_VIEW_TOKEN_SECRET)) {
    throw new Error('SITES_REVALIDATE_SECRET and SITES_VIEW_TOKEN_SECRET are required in production.');
  }
  cached = env;
  return env;
}
