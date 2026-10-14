import { type ApiEnv, apiEnv, loadEnvOrExit, type WorkerEnv, workerEnv } from '@bf/config';

/** DI token for the validated, frozen environment (`@bf/config` apiEnv). */
export const APP_ENV = Symbol('APP_ENV');
/** What shared modules see: the fields both process types have. Entrypoints get their exact type. */
export type AppEnv = ApiEnv | WorkerEnv;

/** How the process runs; decides which modules/providers are wired (ADR-0005). */
export type AppMode = 'http' | 'worker' | 'openapi';

/**
 * Placeholder values for OpenAPI generation, which must run with no env and no infrastructure. Nothing connects in
 * this mode (clients are lazy), so these are never used to reach anything.
 */
const OPENAPI_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://openapi:openapi@127.0.0.1:1/openapi',
  VALKEY_URL: 'redis://127.0.0.1:1',
  S3_ENDPOINT: 'http://127.0.0.1:1',
  S3_ACCESS_KEY_ID: 'openapi',
  S3_SECRET_ACCESS_KEY: 'openapi',
  BETTER_AUTH_SECRET: 'openapi-placeholder-not-a-secret-000000',
  SECRETS_MASTER_KEY: Buffer.alloc(32).toString('base64'),
  SMTP_URL: 'smtp://127.0.0.1:1',
  INTEL_SHARED_SECRET: 'openapi-placeholder-not-a-secret-000000',
} as const;

/** Thrown at boot in production until real authentication exists. */
export class ProductionWithoutAuthError extends Error {
  constructor() {
    super('Refusing to start with NODE_ENV=production: authentication is not implemented yet (BF-010).');
    this.name = 'ProductionWithoutAuthError';
  }
}

export function loadAppEnv(mode: 'worker', source?: Record<string, string | undefined>): WorkerEnv;
export function loadAppEnv(mode: 'http' | 'openapi', source?: Record<string, string | undefined>): ApiEnv;
export function loadAppEnv(mode: AppMode, source?: Record<string, string | undefined>): AppEnv {
  const from = source ? { env: source, files: [] } : {};
  const env =
    mode === 'openapi'
      ? apiEnv.parse(OPENAPI_ENV)
      : mode === 'worker'
        ? loadEnvOrExit(workerEnv, { label: 'worker', ...from })
        : loadEnvOrExit(apiEnv, { label: 'api', ...from });
  // DECISION(BF-006): every /v1 route is open until BF-010 adds auth, so production boots are blocked outright.
  if (env.NODE_ENV === 'production') throw new ProductionWithoutAuthError();
  return env;
}
