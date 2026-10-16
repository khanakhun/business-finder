import type { Clock } from '@bf/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CLOCK } from '../clock/clock.module.ts';
import { VALKEY } from '../valkey/valkey.module.ts';

/** Token bucket per key (a provider and its key, a mailbox…), shared by every process. */
export interface RateLimiter {
  /**
   * One attempt: 0 when `cost` tokens (default 1) were taken, all or none, else the milliseconds until they are
   * available.
   */
  tryTake(
    key: string,
    limit: { readonly capacity: number; readonly perSecond: number; readonly cost?: number },
  ): Promise<number>;
  /** Takes one token, waiting for it up to `maxWaitMs`; false when none came in time. */
  acquire(
    key: string,
    limit: { readonly capacity: number; readonly perSecond: number },
    signal: AbortSignal,
    maxWaitMs?: number,
  ): Promise<boolean>;
}
export const RATE_LIMITER = Symbol('RateLimiter');

/**
 * Token bucket in one Lua call (atomic across processes): refills `perSecond` tokens per second up to `capacity`;
 * returns 0 when `cost` tokens were taken (all or none), else the milliseconds until they are available. Time is the
 * Valkey server's (one clock for every process), unless a test drives its own clock.
 */
const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4]) or 1
if not now then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate / 1000)
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
else
  wait = math.ceil((cost - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000) + 1000)
return wait
`;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

@Injectable()
export class ValkeyRateLimiter implements RateLimiter {
  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    /** Tests drive time with their clock; production uses the server's TIME. */
    @Optional() private readonly useClientTime: boolean = false,
  ) {}

  /** One attempt: 0 when the tokens were taken, else the wait in ms. */
  async tryTake(key: string, limit: { capacity: number; perSecond: number; cost?: number }): Promise<number> {
    const wait = await this.valkey.eval(
      TOKEN_BUCKET,
      1,
      `bf:ratelimit:${key}`,
      limit.capacity,
      limit.perSecond,
      this.useClientTime ? this.clock.now().getTime() : '',
      limit.cost ?? 1,
    );
    return Number(wait);
  }

  async acquire(
    key: string,
    limit: { capacity: number; perSecond: number },
    signal: AbortSignal,
    maxWaitMs = 30_000,
  ): Promise<boolean> {
    const deadline = this.clock.now().getTime() + maxWaitMs;
    for (;;) {
      signal.throwIfAborted();
      const wait = await this.tryTake(key, limit);
      if (wait === 0) return true;
      const now = this.clock.now().getTime();
      if (now + wait > deadline) return false;
      await sleep(wait, signal);
    }
  }
}
