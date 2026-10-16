import { type DbClient, getExecutor } from '@bf/db';
import { geocodeCache } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { GeocodeCache, GeocodeCacheKey, GeocodeResult } from '../application/ports.ts';

/** Expired entries removed per write, so the table stays bounded without a separate job. */
const PRUNE_BATCH = 100;

const keyMatches = (key: GeocodeCacheKey) =>
  and(
    eq(geocodeCache.queryNormalized, key.query),
    eq(geocodeCache.provider, key.provider),
    eq(geocodeCache.countryHint, key.countryHint),
    eq(geocodeCache.locale, key.locale),
    eq(geocodeCache.scope, key.scope),
  );

@Injectable()
export class DrizzleGeocodeCache implements GeocodeCache {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async get(key: GeocodeCacheKey): Promise<GeocodeResult[] | undefined> {
    const [row] = await getExecutor(this.db)
      .select({ result: geocodeCache.result })
      .from(geocodeCache)
      .where(and(keyMatches(key), gt(geocodeCache.expiresAt, sql`now()`)));
    return row ? (row.result as GeocodeResult[]) : undefined;
  }

  async put(key: GeocodeCacheKey, results: readonly GeocodeResult[], ttlSeconds: number) {
    const executor = getExecutor(this.db);
    await executor
      .insert(geocodeCache)
      .values({
        queryNormalized: key.query,
        provider: key.provider,
        countryHint: key.countryHint,
        locale: key.locale,
        scope: key.scope,
        result: results,
        expiresAt: sql`now() + make_interval(secs => ${ttlSeconds})`,
      })
      .onConflictDoUpdate({
        target: [
          geocodeCache.queryNormalized,
          geocodeCache.provider,
          geocodeCache.countryHint,
          geocodeCache.locale,
          geocodeCache.scope,
        ],
        set: { result: sql`excluded.result`, createdAt: sql`now()`, expiresAt: sql`excluded.expires_at` },
      });
    await executor.execute(sql`
      DELETE FROM geocode_cache
      WHERE ctid IN (SELECT ctid FROM geocode_cache WHERE expires_at < now() LIMIT ${PRUNE_BATCH})`);
  }
}
