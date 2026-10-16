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
    .min(1)
    .default('sites.localhost')
    .describe('Previews are served at https://<slug>.<SITES_BASE_DOMAIN> (no scheme, no port).'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url()
    .optional()
    .describe('OTLP/HTTP endpoint for traces/metrics/logs (BF-005). Unset disables export.'),
});
