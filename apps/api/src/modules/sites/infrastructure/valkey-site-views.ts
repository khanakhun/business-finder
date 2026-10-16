import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import type { DayViews, SiteViewCounter } from '../application/ports.ts';

// View counters in Valkey (BF-035): per site and day (page views, a HyperLogLog of visitor hashes, views per locale
// and per campaign) and per site and hour (views and a HyperLogLog), with sets of what changed since the last flush.

const PREFIX = 'sites:views';
const DIRTY_DAYS = `${PREFIX}:dirty-days`;
const DIRTY_HOURS = `${PREFIX}:dirty-hours`;
/** Kept a little longer than they are needed (a flush can be late). */
const DAY_TTL_SECONDS = 3 * 86_400;
const HOUR_TTL_SECONDS = 2 * 86_400;

const dayKey = (day: string, siteId: string, part: string) => `${PREFIX}:d:${day}:${siteId}:${part}`;
const hourKey = (hour: string, siteId: string, part: string) => `${PREFIX}:h:${hour}:${siteId}:${part}`;

@Injectable()
export class ValkeySiteViewCounter implements SiteViewCounter {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async record(view: {
    siteId: string;
    day: string;
    hour: string;
    visitor: string;
    locale: string;
    campaign?: string | undefined;
  }): Promise<void> {
    const { siteId, day, hour } = view;
    const multi = this.valkey.multi();
    multi.incr(dayKey(day, siteId, 'pv')).expire(dayKey(day, siteId, 'pv'), DAY_TTL_SECONDS);
    multi.pfadd(dayKey(day, siteId, 'uv'), view.visitor).expire(dayKey(day, siteId, 'uv'), DAY_TTL_SECONDS);
    multi
      .hincrby(dayKey(day, siteId, 'loc'), view.locale, 1)
      .expire(dayKey(day, siteId, 'loc'), DAY_TTL_SECONDS);
    if (view.campaign) {
      multi
        .hincrby(dayKey(day, siteId, 'camp'), view.campaign, 1)
        .expire(dayKey(day, siteId, 'camp'), DAY_TTL_SECONDS);
    }
    multi.incr(hourKey(hour, siteId, 'pv')).expire(hourKey(hour, siteId, 'pv'), HOUR_TTL_SECONDS);
    multi
      .pfadd(hourKey(hour, siteId, 'uv'), view.visitor)
      .expire(hourKey(hour, siteId, 'uv'), HOUR_TTL_SECONDS);
    multi.sadd(DIRTY_DAYS, `${day}|${siteId}`).sadd(DIRTY_HOURS, `${hour}|${siteId}`);
    await multi.exec();
  }

  /**
   * The (day, site) pairs viewed since the last call, with their totals. A pair is taken off the dirty set before it
   * is read: a view arriving meanwhile marks it again, so the next flush writes it (totals are absolute).
   */
  async takeDays(limit: number): Promise<DayViews[]> {
    const members = await this.valkey.spop(DIRTY_DAYS, limit);
    const result: DayViews[] = [];
    for (const member of members) {
      const [day = '', siteId = ''] = member.split('|');
      const [pv, uv, loc, camp] = await Promise.all([
        this.valkey.get(dayKey(day, siteId, 'pv')),
        this.valkey.pfcount(dayKey(day, siteId, 'uv')),
        this.valkey.hgetall(dayKey(day, siteId, 'loc')),
        this.valkey.hgetall(dayKey(day, siteId, 'camp')),
      ]);
      result.push({
        siteId,
        day,
        pageViews: Number(pv ?? 0),
        uniqueEstimate: uv,
        byLocale: Object.fromEntries(Object.entries(loc).map(([key, value]) => [key, Number(value)])),
        byCampaign: Object.fromEntries(Object.entries(camp).map(([key, value]) => [key, Number(value)])),
      });
    }
    return result;
  }

  /** Puts back pairs whose write failed (the next flush retries them). */
  async returnDays(views: readonly DayViews[]): Promise<void> {
    if (views.length > 0) await this.valkey.sadd(DIRTY_DAYS, ...views.map((v) => `${v.day}|${v.siteId}`));
  }

  /** The (hour, site) pairs of hours before `beforeHour` with views, and their totals. */
  async completedHours(
    beforeHour: string,
    limit: number,
  ): Promise<{ siteId: string; hour: string; pageViews: number; uniqueEstimate: number }[]> {
    const members = (await this.valkey.smembers(DIRTY_HOURS)).filter((member) => member < `${beforeHour}|`);
    const hours = [];
    for (const member of members.slice(0, limit)) {
      const [hour = '', siteId = ''] = member.split('|');
      const [pv, uv] = await Promise.all([
        this.valkey.get(hourKey(hour, siteId, 'pv')),
        this.valkey.pfcount(hourKey(hour, siteId, 'uv')),
      ]);
      hours.push({ siteId, hour, pageViews: Number(pv ?? 0), uniqueEstimate: uv });
    }
    return hours;
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
