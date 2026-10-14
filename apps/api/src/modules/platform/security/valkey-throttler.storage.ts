import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type { Logger } from '../logging/logger.ts';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

// One round-trip, atomic: count the hit, start the window on the first hit, and block once over the limit.
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl <= 0 and hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  blockTtl = tonumber(ARGV[3])
end
return { hits, ttl, blockTtl }
`;

// Connection states in which no command can be sent right now ('wait' is lazy-connect: the first command connects).
const UNAVAILABLE = new Set(['reconnecting', 'close', 'end']);

const ALLOW: ThrottlerStorageRecord = {
  totalHits: 0,
  timeToExpire: 0,
  isBlocked: false,
  timeToBlockExpire: 0,
};

/**
 * Throttler storage on Valkey so limits hold across API instances. (`@nest-lab/throttler-storage-redis` does
 * not support NestJS 12 yet; the interface is four numbers.)
 *
 * DECISION(BF-006): fails open — if Valkey is unreachable, requests are allowed (and a warning logged) rather
 * than every request failing; readiness reports the outage.
 */
export class ValkeyThrottlerStorage implements ThrottlerStorage {
  private degraded = false;

  constructor(
    private readonly valkey: Redis,
    private readonly logger?: Logger,
    private readonly prefix = 'bf:throttle:',
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${this.prefix}${throttlerName}:${key}`;
    // While ioredis is reconnecting, a command would only wait in its offline queue: allow without the round-trip.
    if (UNAVAILABLE.has(this.valkey.status)) return this.allow(new Error(`valkey ${this.valkey.status}`));
    let reply: [number, number, number];
    try {
      reply = (await this.valkey.eval(
        INCREMENT,
        2,
        `${base}:hits`,
        `${base}:blocked`,
        String(ttl),
        String(limit),
        String(blockDuration > 0 ? blockDuration : ttl),
      )) as [number, number, number];
    } catch (error) {
      return this.allow(error);
    }
    if (this.degraded) {
      this.degraded = false;
      this.logger?.info('rate limiter available again');
    }
    const [hits, ttlMs, blockMs] = reply;
    const blocked = blockMs > 0;
    return {
      totalHits: hits,
      timeToExpire: Math.max(0, Math.ceil(ttlMs / 1000)),
      isBlocked: blocked,
      timeToBlockExpire: blocked ? Math.ceil(blockMs / 1000) : 0,
    };
  }

  /** Fails open; warns once per outage rather than on every request. */
  private allow(error: unknown): ThrottlerStorageRecord {
    if (!this.degraded) {
      this.degraded = true;
      this.logger?.warn({ err: error }, 'rate limiter unavailable, allowing requests');
    }
    return ALLOW;
  }
}
