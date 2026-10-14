import type { Redis } from 'ioredis';

export type IdempotencyState = 'acquired' | 'running' | 'done';

const RUNNING = 'running';
const DONE = 'done';

/**
 * At-most-once processing per idempotency key across retries, duplicate deliveries and replays:
 * `acquire` claims the key (SET NX) unless another run holds it or it already completed.
 */
export class IdempotencyGuard {
  constructor(
    private readonly valkey: Redis,
    /** How long a crashed run's claim blocks others (should exceed the job timeout). */
    private readonly runningTtlSeconds = 15 * 60,
    /** How long completion is remembered (should exceed the queue's retention). */
    private readonly doneTtlSeconds = 7 * 24 * 3600,
  ) {}

  async acquire(key: string): Promise<IdempotencyState> {
    const claimed = await this.valkey.set(key, RUNNING, 'EX', this.runningTtlSeconds, 'NX');
    if (claimed === 'OK') return 'acquired';
    return (await this.valkey.get(key)) === DONE ? 'done' : 'running';
  }

  async complete(key: string): Promise<void> {
    await this.valkey.set(key, DONE, 'EX', this.doneTtlSeconds);
  }

  /** After a failure, so the next retry can run. */
  async release(key: string): Promise<void> {
    await this.valkey.del(key);
  }
}
