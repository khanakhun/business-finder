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
