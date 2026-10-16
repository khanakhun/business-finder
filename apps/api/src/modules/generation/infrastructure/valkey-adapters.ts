import { randomUUID } from 'node:crypto';
import type { EngineEvent } from '@bf/contracts';
import { requestCancellation, watchCancellation } from '@bf/queue';
import type { Redis } from 'ioredis';
import type { CancelSignals, EventStream, LeaseSemaphore } from '../application/ports.ts';

// Valkey adapters of generation (BF-039): counting semaphores with expiring leases (a crashed worker's slot frees
// itself), cancellation requests any process can raise, and the live event stream per job.

/**
 * Leases as members of a sorted set scored by their expiry: expired ones are dropped first, then a slot is taken
 * when fewer than `limit` remain — atomically (one Lua script).
 */
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0`;

export class ValkeyLeaseSemaphore implements LeaseSemaphore {
  constructor(
    private readonly valkey: Pick<Redis, 'eval' | 'zadd' | 'zrem' | 'zremrangebyscore' | 'zcard' | 'pexpire'>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async acquire(key: string, limit: number, ttlMs: number): Promise<string | null> {
    if (limit <= 0) return null;
    const token = randomUUID();
    const now = this.now();
    const ok = await this.valkey.eval(
      ACQUIRE,
      1,
      key,
      String(now),
      String(now + ttlMs),
      String(limit),
      token,
      String(ttlMs * 2),
    );
    return ok === 1 ? token : null;
  }

  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    // XX: only a lease still held is extended (one dropped as expired is gone).
    const changed = await this.valkey.zadd(key, 'XX', 'CH', this.now() + ttlMs, token);
    await this.valkey.pexpire(key, ttlMs * 2);
    return Number(changed) === 1;
  }

  async release(key: string, token: string): Promise<void> {
    await this.valkey.zrem(key, token);
  }

  async held(key: string): Promise<number> {
    await this.valkey.zremrangebyscore(key, '-inf', String(this.now()));
    return this.valkey.zcard(key);
  }
}

const CANCEL_QUEUE = 'generation';

export class ValkeyCancelSignals implements CancelSignals {
  constructor(private readonly valkey: Redis) {}

  request(jobId: string) {
    return requestCancellation(this.valkey, CANCEL_QUEUE, jobId);
  }

  watch(jobId: string) {
    return watchCancellation(this.valkey, CANCEL_QUEUE, jobId, 500);
  }
}

/** Each job's events on a capped Valkey stream (`gen:job:<id>`): the SSE endpoint tails it after replaying the log. */
export class ValkeyEventStream implements EventStream {
  constructor(private readonly valkey: Pick<Redis, 'xadd' | 'expire'>) {}

  async publish(jobId: string, entries: readonly { seq: number; event: EngineEvent }[]): Promise<void> {
    const key = `gen:job:${jobId}`;
    for (const { seq, event } of entries)
      await this.valkey.xadd(
        key,
        'MAXLEN',
        '~',
        '2000',
        '*',
        'seq',
        String(seq),
        'event',
        JSON.stringify(event),
      );
    await this.valkey.expire(key, 86_400);
  }

  async status(jobId: string, status: string): Promise<void> {
    const key = `gen:job:${jobId}`;
    await this.valkey.xadd(key, 'MAXLEN', '~', '2000', '*', 'status', status);
    await this.valkey.expire(key, 86_400);
  }
}
