import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import type { GeocodeQuota } from '../application/ports.ts';

/** Fixed one-minute window per workspace in Valkey (shared by every API process). */
@Injectable()
export class ValkeyGeocodeQuota implements GeocodeQuota {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  async take(organizationId: string | null): Promise<boolean> {
    const window = Math.floor(Date.now() / 60_000);
    const key = `bf:geo:quota:${organizationId ?? 'none'}:${window}`;
    const [[, count] = [null, 0]] = (await this.valkey.multi().incr(key).expire(key, 120).exec()) ?? [];
    return Number(count) <= this.env.GEOCODER_LOOKUPS_PER_MINUTE;
  }
}
