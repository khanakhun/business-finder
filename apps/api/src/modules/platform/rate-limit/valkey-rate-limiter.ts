import type { Clock } from '@bf/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import type { RateLimiter } from '../application/ports.ts';

/**
 * Token bucket in one Lua call (atomic across processes): refills `perSecond` tokens per second up to `capacity`;
 * returns 0 when a token was taken, else the milliseconds until one is available. Time is the Valkey server's
 * (one clock for every process), unless a test drives its own clock.
 */
const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if not now then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate / 1000)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
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

  /** One attempt: 0 when a token was taken, else the wait in ms. */
  async tryTake(key: string, limit: { capacity: number; perSecond: number }): Promise<number> {
    const wait = await this.valkey.eval(
      TOKEN_BUCKET,
      1,
      `bf:ratelimit:${key}`,
      limit.capacity,
      limit.perSecond,
      this.useClientTime ? this.clock.now().getTime() : '',
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
