import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../../platform/valkey/valkey.module.ts';
import type { OAuthAttempt, OAuthAttemptStore, RefreshLock } from '../../application/mailbox/ports.ts';

// OAuth attempts (single use, 10 minutes) and the per-mailbox token refresh lock (BF-050), in Valkey.

const PREFIX = 'outreach:oauth';
const LOCK_MS = 15_000;

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

@Injectable()
export class ValkeyOAuthStore implements OAuthAttemptStore, RefreshLock {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async put(nonce: string, attempt: OAuthAttempt, ttlSeconds: number) {
    await this.valkey.set(`${PREFIX}:attempt:${nonce}`, JSON.stringify(attempt), 'EX', ttlSeconds);
  }

  async take(nonce: string) {
    const value = await this.valkey.getdel(`${PREFIX}:attempt:${nonce}`);
    return value ? (JSON.parse(value) as OAuthAttempt) : null;
  }

  async withLock<T>(mailboxId: string, fn: () => Promise<T>): Promise<T | null> {
    const key = `${PREFIX}:refresh:${mailboxId}`;
    const owner = randomUUID();
    if ((await this.valkey.set(key, owner, 'PX', LOCK_MS, 'NX')) !== 'OK') return null;
    try {
      return await fn();
    } finally {
      await this.valkey.eval(RELEASE, 1, key, owner);
    }
  }
}
