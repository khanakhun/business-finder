import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { LOGGER } from '../../platform/logging/logger.ts';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import type { RankingCache } from '../application/listing-ports.ts';

const PREFIX = 'bf:search:ranking:';
const RankingSchema = z.array(z.object({ id: z.uuid(), score: z.number() })).max(1_000);
type Ranking = Array<{ id: string; score: number }>;

/** Best effort: Valkey down or a corrupt entry is a miss (the ranking is recomputed), never a failed search. */
@Injectable()
export class ValkeyRankingCache implements RankingCache {
  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async get(key: string): Promise<Ranking | undefined> {
    try {
      const raw = await this.valkey.get(`${PREFIX}${key}`);
      if (!raw) return undefined;
      const parsed = RankingSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      this.logger.warn({ err: error }, 'ranking cache read failed; treated as a miss');
      return undefined;
    }
  }

  async set(
    key: string,
    value: ReadonlyArray<{ id: string; score: number }>,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.valkey.set(`${PREFIX}${key}`, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn({ err: error }, 'ranking cache write failed');
    }
  }
}
