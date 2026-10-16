import { z } from 'zod';
import { coreEnv } from '../fragments/core.ts';
import { intelEnv as intelClientEnv } from '../fragments/intel.ts';
import { s3Env } from '../fragments/s3.ts';
import { port } from '../schema.ts';

/**
 * services/intel (Python) reads these through pydantic-settings (services/intel/app/settings.py, BF-008).
 * Declared here so every variable has one documented source of truth; a Python test fails if the settings
 * model and `.env.example` (generated from this schema) disagree.
 */
export const intelServiceEnv = z.object({
  NODE_ENV: coreEnv.shape.NODE_ENV,
  LOG_LEVEL: coreEnv.shape.LOG_LEVEL,
  APP_VERSION: coreEnv.shape.APP_VERSION,
  OTEL_EXPORTER_OTLP_ENDPOINT: coreEnv.shape.OTEL_EXPORTER_OTLP_ENDPOINT,
  INTEL_SHARED_SECRET: intelClientEnv.shape.INTEL_SHARED_SECRET,
  ...s3Env.shape,
  INTEL_HOST: z
    .string()
    .min(1)
    .default('127.0.0.1')
    .describe('Interface services/intel binds to (0.0.0.0 inside its container).'),
  INTEL_PORT: port(8000).describe('HTTP port of services/intel. Set by infra:up from BF_PORT_OFFSET.'),
  INTEL_WORKERS: z.coerce
    .number()
    .int()
    .min(1)
    .max(32)
    .default(1)
    .describe('Uvicorn worker processes. Prefer more replicas: metrics and the nonce cache are per process.'),
  INTEL_CPU_WORKERS: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe('Process-pool size for CPU-bound work (default: CPU count).'),
  INTEL_MAX_REQUEST_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1_048_576)
    .describe('Largest request body accepted on /v1, checked before authentication (bytes).'),
  INTEL_FETCH_TIMEOUT_SECONDS: z.coerce
    .number()
    .positive()
    .max(300)
    .default(20)
    .describe('Total time budget of one safe_fetch call, redirects included.'),
  INTEL_FETCH_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10_485_760)
    .describe('Largest response body safe_fetch accepts after decompression (bytes).'),
});
export type IntelServiceEnv = z.output<typeof intelServiceEnv>;
