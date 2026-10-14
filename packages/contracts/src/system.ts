import { z } from 'zod';
import { defineJob } from './jobs.ts';
import { IsoDateTimeSchema } from './time.ts';

/** `GET /v1/system/info` (reference module, BF-006). */
export const SystemInfoSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    commit: z.string().nullable(),
    env: z.enum(['development', 'test', 'production']),
    time: IsoDateTimeSchema,
  })
  .meta({ id: 'SystemInfo', description: 'Build and runtime information about the API process.' });
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

/** `POST /v1/system/ping-jobs` body. */
export const PingJobsRequestSchema = z
  .object({
    count: z.number().int().min(1).max(10).default(1).describe('How many ping jobs to enqueue.'),
    idempotencyKey: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Re-sending the same key enqueues nothing new.'),
  })
  .meta({
    id: 'PingJobsRequest',
    description: 'Enqueue system.ping jobs (smoke test for the queue pipeline).',
  });
export type PingJobsRequest = z.infer<typeof PingJobsRequestSchema>;

export const PingJobsAcceptedSchema = z
  .object({ jobIds: z.array(z.string()).min(1) })
  .meta({ id: 'PingJobsAccepted', description: 'Ids of the enqueued jobs.' });
export type PingJobsAccepted = z.infer<typeof PingJobsAcceptedSchema>;

/** `system.ping` job: proves the queue pipeline end to end (producer → worker, trace, idempotency, metrics). */
export const SystemPingJob = defineJob('system', 'ping', {
  sequence: z.number().int().min(0).describe('Position within the request that enqueued it.'),
});
