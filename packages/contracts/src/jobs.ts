import { z } from 'zod';
import { OrgId, UserId } from './ids.ts';

// W3C trace context `traceparent`: version-traceid-parentid-flags.
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Fields every job payload carries; handlers must be idempotent on `idempotencyKey` (AGENTS.md §6). */
export const JobPayloadBase = z.object({
  idempotencyKey: z.string().min(1).max(200),
  orgId: OrgId.nullable(),
  traceparent: z.string().regex(TRACEPARENT).optional(),
  requestedBy: UserId.optional(),
});
export type JobPayloadBase = z.infer<typeof JobPayloadBase>;

const NAME = /^[a-z][a-z0-9-]*$/;

export interface JobDefinition<TQueue extends string, TName extends string, TShape extends z.ZodRawShape> {
  readonly queue: TQueue;
  readonly name: TName;
  readonly schema: z.ZodObject<typeof JobPayloadBase.shape & TShape>;
}

const jobRegistry = new Map<string, JobDefinition<string, string, z.ZodRawShape>>();

/** Declares a job: its payload is `JobPayloadBase` extended with `shape`. Queue + name must be unique. */
export function defineJob<TQueue extends string, TName extends string, TShape extends z.ZodRawShape>(
  queue: TQueue,
  name: TName,
  shape: TShape,
): JobDefinition<TQueue, TName, TShape> {
  if (!NAME.test(queue) || !NAME.test(name)) throw new Error(`Queue and job names must be kebab-case`);
  const key = `${queue}/${name}`;
  if (jobRegistry.has(key)) throw new Error(`Job ${key} is already defined`);
  const definition = { queue, name, schema: JobPayloadBase.extend(shape) };
  jobRegistry.set(key, definition as unknown as JobDefinition<string, string, z.ZodRawShape>);
  return definition;
}

export function getJobDefinition(
  queue: string,
  name: string,
): JobDefinition<string, string, z.ZodRawShape> | undefined {
  return jobRegistry.get(`${queue}/${name}`);
}
