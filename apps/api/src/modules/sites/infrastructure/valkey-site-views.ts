import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import type { DayViews, SiteViewCounter } from '../application/ports.ts';

// View counters in Valkey (BF-035): per site and day (page views, a HyperLogLog of visitor hashes, views per locale
// and per campaign) and per site and hour (views and a HyperLogLog), with sets of what changed since the last flush.

const PREFIX = 'sites:views';
/** A sorted set: each (day, site) pair scored by its number of views since it was last written. */
const DIRTY_DAYS = `${PREFIX}:dirty-days`;
const DIRTY_HOURS = `${PREFIX}:dirty-hours`;
/** Views one visitor adds to a site's day; more are not counted (a replayed token inflates nothing). */
export const MAX_VIEWS_PER_VISITOR = 30;
/** Distinct campaign references a site's day keeps; later ones are counted as `~other`. */
export const MAX_CAMPAIGNS = 50;
/** Kept a little longer than they are needed (a flush can be late). */
const DAY_TTL_SECONDS = 3 * 86_400;
const HOUR_TTL_SECONDS = 2 * 86_400;

const dayKey = (day: string, siteId: string, part: string) => `${PREFIX}:d:${day}:${siteId}:${part}`;
const hourKey = (hour: string, siteId: string, part: string) => `${PREFIX}:h:${hour}:${siteId}:${part}`;

/**
 * One view, atomically: the visitor's count first (past the cap nothing is counted), then the day's and the hour's
 * counters, the campaign (or `~other` past the cap) and the dirty marks.
 */
const RECORD = `
local n = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('EXPIRE', KEYS[1], ARGV[4])
if n > tonumber(ARGV[8]) then return 0 end
redis.call('INCR', KEYS[2]) redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('PFADD', KEYS[3], ARGV[1]) redis.call('EXPIRE', KEYS[3], ARGV[4])
redis.call('HINCRBY', KEYS[4], ARGV[2], 1) redis.call('EXPIRE', KEYS[4], ARGV[4])
if ARGV[3] ~= '' then
  local field = ARGV[3]
  if redis.call('HEXISTS', KEYS[5], field) == 0 and redis.call('HLEN', KEYS[5]) >= tonumber(ARGV[9]) then
    field = '~other'
  end
  redis.call('HINCRBY', KEYS[5], field, 1) redis.call('EXPIRE', KEYS[5], ARGV[4])
end
redis.call('INCR', KEYS[6]) redis.call('EXPIRE', KEYS[6], ARGV[5])
redis.call('PFADD', KEYS[7], ARGV[1]) redis.call('EXPIRE', KEYS[7], ARGV[5])
redis.call('ZINCRBY', KEYS[8], 1, ARGV[6])
redis.call('SADD', KEYS[9], ARGV[7])
return 1
`;

/** Removes the pairs whose score is still the one read (a view since then keeps the pair for the next flush). */
const CLEAR = `
for i = 1, #ARGV, 2 do
  local score = redis.call('ZSCORE', KEYS[1], ARGV[i])
  if score and tonumber(score) == tonumber(ARGV[i + 1]) then redis.call('ZREM', KEYS[1], ARGV[i]) end
end
return 0
`;

const numbers = (hash: Record<string, string>) =>
  Object.fromEntries(Object.entries(hash).map(([key, value]) => [key, Number(value)]));

@Injectable()
export class ValkeySiteViewCounter implements SiteViewCounter {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async dailySalt(day: string): Promise<string> {
    const key = `${PREFIX}:salt:${day}`;
    await this.valkey.set(key, randomBytes(32).toString('hex'), 'EX', 2 * 86_400, 'NX');
    const salt = await this.valkey.get(key);
    if (!salt) throw new Error('site view salt unavailable');
    return salt;
  }

  async record(view: Parameters<SiteViewCounter['record']>[0]): Promise<boolean> {
    const { siteId, day, hour } = view;
    const counted = await this.valkey.eval(
      RECORD,
      9,
      dayKey(day, siteId, 'visits'),
      dayKey(day, siteId, 'pv'),
      dayKey(day, siteId, 'uv'),
      dayKey(day, siteId, 'loc'),
      dayKey(day, siteId, 'camp'),
      hourKey(hour, siteId, 'pv'),
      hourKey(hour, siteId, 'uv'),
      DIRTY_DAYS,
      DIRTY_HOURS,
      view.visitor,
      view.locale,
      view.campaign ?? '',
      DAY_TTL_SECONDS,
      HOUR_TTL_SECONDS,
      `${day}|${siteId}`,
      `${hour}|${siteId}`,
      MAX_VIEWS_PER_VISITOR,
      MAX_CAMPAIGNS,
    );
    return counted === 1;
  }

  async pendingDays(limit: number) {
    // RESP2 (the connection's protocol): a flat list of members and scores.
    const flat = (await this.valkey.zrange(DIRTY_DAYS, 0, String(limit - 1), 'WITHSCORES')) as string[];
    const pairs: { member: string; version: string }[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2)
      pairs.push({ member: flat[i] ?? '', version: flat[i + 1] ?? '0' });
    if (pairs.length === 0) return [];
    const pipeline = this.valkey.pipeline();
    for (const { member } of pairs) {
      const [day = '', siteId = ''] = member.split('|');
      pipeline
        .get(dayKey(day, siteId, 'pv'))
        .pfcount(dayKey(day, siteId, 'uv'))
        .hgetall(dayKey(day, siteId, 'loc'))
        .hgetall(dayKey(day, siteId, 'camp'));
    }
    const results = (await pipeline.exec()) ?? [];
    return pairs.map(({ member, version }, i) => {
      const [day = '', siteId = ''] = member.split('|');
      const at = (k: number) => {
        const [error, value] = results[i * 4 + k] ?? [null, null];
        if (error) throw error;
        return value;
      };
      return {
        siteId,
        day,
        version,
        pageViews: Number(at(0) ?? 0),
        uniqueEstimate: Number(at(1) ?? 0),
        byLocale: numbers((at(2) ?? {}) as Record<string, string>),
        byCampaign: numbers((at(3) ?? {}) as Record<string, string>),
      };
    });
  }

  async clearDays(views: readonly { siteId: string; day: string; version: string }[]): Promise<void> {
    if (views.length === 0) return;
    await this.valkey.eval(
      CLEAR,
      1,
      DIRTY_DAYS,
      ...views.flatMap((v) => [`${v.day}|${v.siteId}`, v.version]),
    );
  }

  /** The (hour, site) pairs of hours before `beforeHour` with views, and their totals. */
  async completedHours(
    beforeHour: string,
    limit: number,
  ): Promise<{ siteId: string; hour: string; pageViews: number; uniqueEstimate: number }[]> {
    const members = (await this.valkey.smembers(DIRTY_HOURS))
      .filter((member) => member < `${beforeHour}|`)
      .slice(0, limit);
    if (members.length === 0) return [];
    const pipeline = this.valkey.pipeline();
    for (const member of members) {
      const [hour = '', siteId = ''] = member.split('|');
      pipeline.get(hourKey(hour, siteId, 'pv')).pfcount(hourKey(hour, siteId, 'uv'));
    }
    const results = (await pipeline.exec()) ?? [];
    return members.map((member, i) => {
      const [hour = '', siteId = ''] = member.split('|');
      const [pvError, pv] = results[i * 2] ?? [null, null];
      const [uvError, uv] = results[i * 2 + 1] ?? [null, null];
      if (pvError || uvError) throw pvError ?? uvError;
      return { siteId, hour, pageViews: Number(pv ?? 0), uniqueEstimate: Number(uv ?? 0) };
    });
  }

  /** Forgets an hour once its event is recorded. */
  async forgetHour(siteId: string, hour: string): Promise<void> {
    await this.valkey
      .multi()
      .srem(DIRTY_HOURS, `${hour}|${siteId}`)
      .del(hourKey(hour, siteId, 'pv'), hourKey(hour, siteId, 'uv'))
      .exec();
  }
}
