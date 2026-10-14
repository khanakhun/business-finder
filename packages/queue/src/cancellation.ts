import type { Redis } from 'ioredis';
import { keys } from './keys.ts';

/** Asks a running job to stop, from any process (API, another worker). The job sees it within `pollMs`. */
export async function requestCancellation(
  valkey: Redis,
  queue: string,
  jobId: string,
  ttlSeconds = 3600,
): Promise<void> {
  await valkey.set(keys.cancel(queue, jobId), '1', 'EX', ttlSeconds);
}

/** Aborts the returned signal once a cancellation is requested for the job. Call `stop()` when the job ends. */
export function watchCancellation(
  valkey: Redis,
  queue: string,
  jobId: string,
  pollMs = 500,
): { signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  const key = keys.cancel(queue, jobId);
  const check = async () => {
    try {
      if ((await valkey.exists(key)) === 1) controller.abort(new JobCancelledError(jobId));
    } catch {
      // A transient Valkey error must not fail the job; the next poll retries.
    }
  };
  void check();
  const timer = setInterval(() => void check(), pollMs);
  timer.unref();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

export class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled`);
    this.name = 'JobCancelledError';
  }
}
