import { z } from 'zod';
import { coreEnv } from '../fragments/core.ts';
import { intelEnv as intelClientEnv } from '../fragments/intel.ts';
import { s3Env } from '../fragments/s3.ts';
import { port } from '../schema.ts';

/**
 * services/intel (Python) reads these through pydantic-settings (BF-008). Declared here so every variable has
 * one documented source of truth; the Python settings model must stay in sync.
 */
export const intelServiceEnv = z.object({
  LOG_LEVEL: coreEnv.shape.LOG_LEVEL,
  OTEL_EXPORTER_OTLP_ENDPOINT: coreEnv.shape.OTEL_EXPORTER_OTLP_ENDPOINT,
  INTEL_SHARED_SECRET: intelClientEnv.shape.INTEL_SHARED_SECRET,
  ...s3Env.shape,
  INTEL_PORT: port(8000).describe('HTTP port of services/intel. Set by infra:up from BF_PORT_OFFSET.'),
});
export type IntelServiceEnv = z.output<typeof intelServiceEnv>;
