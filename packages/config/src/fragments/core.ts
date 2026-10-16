import { z } from 'zod';

export const coreEnv = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development')
    .describe('Runtime mode. Production enables secure cookies, JSON logs and stricter checks.'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info')
    .describe('Minimum log level.'),
  APP_URL: z.url().default('http://localhost:3000').describe('Public URL of the dashboard (apps/web).'),
  API_URL: z.url().default('http://localhost:4000').describe('Public URL of the API (apps/api).'),
  SITES_BASE_DOMAIN: z
    .string()
    .regex(
      /^(?=.{1,200}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
      'A lowercase hostname, e.g. sites.example.com',
    )
    .default('sites.localhost')
    .describe('Previews are served at https://<slug>.<SITES_BASE_DOMAIN> (no scheme, no port).'),
  APP_VERSION: z
    .string()
    .min(1)
    .default('0.0.0-dev')
    .describe('Release version, set by the build/deploy pipeline.'),
  GIT_COMMIT: z
    .string()
    .min(1)
    .optional()
    .describe('Git commit SHA of the running build, set by the build/deploy pipeline.'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url()
    .optional()
    .describe('OTLP/HTTP endpoint for traces/metrics/logs (BF-005). Unset disables export.'),
});
