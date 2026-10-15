import type { BuildInfo } from '../domain/system-info.ts';

/** Port: where build facts come from (config today; could be a manifest file). */
export interface BuildInfoProvider {
  get(): BuildInfo;
}
export const BUILD_INFO_PROVIDER = Symbol('BuildInfoProvider');

/** Port: enqueue a `system.ping` job; returns its job id. */
export interface PingJobQueue {
  enqueue(job: { readonly idempotencyKey: string; readonly sequence: number }): Promise<string>;
}
export const PING_JOB_QUEUE = Symbol('PingJobQueue');

/** Port: enqueue one outbox delivery (event × subscriber) under a fresh idempotency key; returns the job id. */
export interface EventReplayQueue {
  enqueue(job: {
    readonly eventId: string;
    readonly subscriberId: string;
    readonly orgId: string | null;
    readonly idempotencyKey: string;
  }): Promise<string>;
}
export const EVENT_REPLAY_QUEUE = Symbol('EventReplayQueue');
