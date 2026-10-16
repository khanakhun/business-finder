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
import { port, secret } from '../schema.ts';

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
  // TODO(BF-010): replace basic auth on /admin/queues with RBAC, then remove these.
  BULL_BOARD_USER: z
    .string()
    .min(1)
    .optional()
    .describe('Basic-auth user for the queue dashboard (/admin/queues). Unset = dashboard off.'),
  BULL_BOARD_PASSWORD: secret(
    z.string().min(12).optional().describe('Basic-auth password for the queue dashboard, ≥ 12 chars.'),
  ),
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
