import { z } from 'zod';
import { aiEnv } from '../fragments/ai.ts';
import { authEnv } from '../fragments/auth.ts';
import { coreEnv } from '../fragments/core.ts';
import { dbEnv } from '../fragments/db.ts';
import { featureFlagsEnv } from '../fragments/features.ts';
import { intelEnv } from '../fragments/intel.ts';
import { mailEnv } from '../fragments/mail.ts';
import { s3Env } from '../fragments/s3.ts';
import { valkeyEnv } from '../fragments/valkey.ts';
import { port } from '../schema.ts';

const backendShape = {
  ...coreEnv.shape,
  ...dbEnv.shape,
  ...valkeyEnv.shape,
  ...s3Env.shape,
  ...aiEnv.shape,
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
});
export type WorkerEnv = z.output<typeof workerEnv>;
