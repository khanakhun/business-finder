import { z } from 'zod';
import { aiEnv } from '../fragments/ai.ts';
import { authEnv } from '../fragments/auth.ts';
import { coreEnv } from '../fragments/core.ts';
import { dbEnv } from '../fragments/db.ts';
import { discoveryEnv } from '../fragments/discovery.ts';
import { enrichmentEnv } from '../fragments/enrichment.ts';
import { featureFlagsEnv } from '../fragments/features.ts';
import { geoEnv } from '../fragments/geo.ts';
import { intelEnv } from '../fragments/intel.ts';
import { mailEnv } from '../fragments/mail.ts';
import { providersEnv } from '../fragments/providers.ts';
import { resolutionEnv } from '../fragments/resolution.ts';
import { s3Env } from '../fragments/s3.ts';
import { searchEnv } from '../fragments/search.ts';
import { valkeyEnv } from '../fragments/valkey.ts';
import { port, secret } from '../schema.ts';

const backendShape = {
  ...coreEnv.shape,
  ...dbEnv.shape,
  ...valkeyEnv.shape,
  ...s3Env.shape,
  ...aiEnv.shape,
  ...providersEnv.shape,
  ...resolutionEnv.shape,
  ...geoEnv.shape,
  ...searchEnv.shape,
  ...discoveryEnv.shape,
  ...enrichmentEnv.shape,
  ...authEnv.shape,
  ...mailEnv.shape,
  ...intelEnv.shape,
  ...featureFlagsEnv.shape,
};

export const apiEnv = z.object({
  ...backendShape,
  API_PORT: port(4000).describe('HTTP port of apps/api. Set by infra:up from BF_PORT_OFFSET.'),
});
export type ApiEnv = z.output<typeof apiEnv>;

export const workerEnv = z.object({
  ...backendShape,
  WORKER_METRICS_PORT: port(9464).describe('Prometheus metrics port of the worker process.'),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(30_000)
    .describe('On SIGTERM, how long the worker waits for active jobs before exiting.'),
});
export type WorkerEnv = z.output<typeof workerEnv>;
