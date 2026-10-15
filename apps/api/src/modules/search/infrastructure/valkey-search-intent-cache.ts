import { type ParseSearchIntentResponse, ParseSearchIntentResponseSchema } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { LOGGER } from '../../platform/logging/logger.ts';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import type { SearchIntentCache } from '../application/ports.ts';

const PREFIX = 'bf:search:intent:';

/** Best effort: Valkey down, a corrupt entry or one from an older schema is a miss, never a failed search. */
@Injectable()
export class ValkeySearchIntentCache implements SearchIntentCache {
  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async get(key: string): Promise<ParseSearchIntentResponse | undefined> {
    try {
      const raw = await this.valkey.get(`${PREFIX}${key}`);
      if (!raw) return undefined;
      const parsed = ParseSearchIntentResponseSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      this.logger.warn(
        { path: parsed.error.issues[0]?.path.join('.') },
        'search intent cache entry does not match the schema; treated as a miss',
      );
      return undefined;
    } catch (error) {
      this.logger.warn({ err: error }, 'search intent cache read failed; treated as a miss');
      return undefined;
    }
  }

  async set(key: string, value: ParseSearchIntentResponse, ttlSeconds: number): Promise<void> {
    try {
      await this.valkey.set(`${PREFIX}${key}`, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn({ err: error }, 'search intent cache write failed');
    }
  }
}
