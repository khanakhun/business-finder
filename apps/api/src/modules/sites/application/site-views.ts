import { createHash } from 'node:crypto';
import { type Clock, type SiteViewBeacon, SiteViewed, verifySiteViewToken } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import { dayOf, firstDayOf, hourOf } from '../domain/views.ts';
import {
  SITE_HOSTING,
  SITE_VIEW_COUNTER,
  SITE_VIEW_SECRET,
  SITE_VIEWS_REPOSITORY,
  type SiteHosting,
  type SiteViewCounter,
  type SiteViewsRepository,
} from './ports.ts';

/** How many (day, site) pairs and hours one batch handles, and how many batches one flush runs. */
const FLUSH_BATCH = 1_000;
const FLUSH_ROUNDS = 20;
/** An hour is complete this long after it ends (a view stamped 12:59:59 may land a little later). */
const HOUR_GRACE_MS = 2 * 60_000;

/**
 * The part of an address that names a visitor's network: an IPv4 address, or an IPv6 /64 (a device rotates the
 * rest), written in full (`2001:db8::1:2:3:4:5` is `2001:0db8:0000:0001`) so one network has one name.
 */
export function networkOf(ip: string | undefined): string {
  if (!ip) return '';
  const address = ip.trim().toLowerCase().replace(/%.*$/, '');
  const v4 = address.replace(/^::ffff:/, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4)) return v4;
  if (!/^[0-9a-f:]+$/.test(address) || address.split('::').length > 2) return '';
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => group.length > 4)) return '';
  return groups
    .slice(0, 4)
    .map((group) => group.padStart(4, '0'))
    .join(':');
}

/** An Origin header of a published site's page: http(s), one label under the sites domain. */
export function siteOrigin(origin: string | undefined, baseDomain: string): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const suffix = `.${baseDomain}`;
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname.endsWith(suffix) &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname.slice(0, -suffix.length))
    );
  } catch {
    return false;
  }
}

/**
 * The anonymous view beacon of published pages (BF-035): the token names the site (signed by the renderer), the
 * visitor is a hash of their network address with a random salt of the day (kept in Valkey two days, nowhere else):
 * nothing about the visitor is stored, and a day's hashes cannot be linked to another day's. A visitor counts at most
 * `MAX_VIEWS_PER_VISITOR` views a day per site (a replayed token inflates nothing).
 */
@Injectable()
export class SiteViewRecorder {
  private salt: { day: string; value: string } | undefined;

  constructor(
    @Inject(SITE_VIEW_COUNTER) private readonly counter: SiteViewCounter,
    @Inject(SITE_VIEW_SECRET) private readonly secret: string | undefined,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SITE_HOSTING) private readonly hosting: SiteHosting,
  ) {}

  /** Counts a view; returns whether it was counted (an invalid token, no configuration or a capped visitor: not). */
  async record(
    beacon: SiteViewBeacon,
    visitor: { ip: string | undefined; origin: string | undefined },
  ): Promise<boolean> {
    if (!this.secret) return false;
    // Only a page of one of our sites sends it (any other page could replay a site's public token).
    if (!siteOrigin(visitor.origin, this.hosting.baseDomain)) return false;
    const siteId = await verifySiteViewToken(beacon.token, this.secret);
    if (!siteId) return false;
    const now = this.clock.now();
    const day = dayOf(now);
    if (this.salt?.day !== day) this.salt = { day, value: await this.counter.dailySalt(day) };
    const hash = createHash('sha256')
      .update(`${this.salt.value}|${networkOf(visitor.ip)}`)
      .digest('hex')
      .slice(0, 32);
    return this.counter.record({
      siteId,
      day,
      hour: hourOf(now),
      visitor: hash,
      locale: beacon.locale,
      campaign: beacon.c,
    });
  }
}

/** Moves counted views to the database and emits the hourly `site.viewed` events (the 5-minute job). */
@Injectable()
export class SiteViewsFlusher {
  constructor(
    @Inject(SITE_VIEW_COUNTER) private readonly counter: SiteViewCounter,
    @Inject(SITE_VIEWS_REPOSITORY) private readonly repository: SiteViewsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly events: EventRecorder,
  ) {}

  /**
   * Writes the pending days (a pair leaves the pending set only if no view arrived while it was written, so nothing
   * is lost to a crash or a race) and emits one `site.viewed` per site and completed hour (claimed in the database:
   * a second flush or a late view never emits it again).
   */
  async flush(): Promise<{ days: number; events: number }> {
    let written = 0;
    for (let round = 0; round < FLUSH_ROUNDS; round += 1) {
      const days = await this.counter.pendingDays(FLUSH_BATCH);
      if (days.length === 0) break;
      written += await this.repository.upsertDays(days);
      await this.counter.clearDays(days);
      if (days.length < FLUSH_BATCH) break;
    }
    // Claims of hours whose counters are gone from Valkey (two days) can never matter again.
    await this.repository.pruneHours(hourOf(new Date(this.clock.now().getTime() - 3 * 86_400_000)), 5_000);
    let emitted = 0;
    const complete = hourOf(new Date(this.clock.now().getTime() - HOUR_GRACE_MS));
    const hours = await this.counter.completedHours(complete, FLUSH_BATCH);
    const refs = new Map(
      (await this.repository.refs([...new Set(hours.map((hour) => hour.siteId))])).map((ref) => [
        ref.id,
        ref,
      ]),
    );
    for (const hour of hours) {
      const ref = refs.get(hour.siteId);
      try {
        if (ref && hour.pageViews > 0 && (await this.emit(ref, hour))) emitted += 1;
        await this.counter.forgetHour(hour.siteId, hour.hour);
      } catch (error) {
        this.logger.error({ err: error, siteId: hour.siteId, hour: hour.hour }, 'site.viewed not recorded');
      }
    }
    return { days: written, events: emitted };
  }

  /** Records the hour's event once: the claim and the event commit together. */
  @Transactional()
  private async emit(
    ref: { organizationId: string; businessId: string; id: string },
    hour: { hour: string; pageViews: number; uniqueEstimate: number },
  ): Promise<boolean> {
    if (!(await this.repository.claimHour(ref.id, hour.hour))) return false;
    await this.events.record(SiteViewed, {
      orgId: ref.organizationId,
      actor: { type: 'system', id: 'sites.views' },
      payload: {
        siteId: ref.id as never,
        businessId: ref.businessId as never,
        hourStart: hour.hour,
        pageViews: hour.pageViews,
        uniqueEstimate: Math.min(hour.uniqueEstimate, hour.pageViews),
      },
    });
    return true;
  }

  /** A site's views over the last 7 and 30 days (today included); unique visitors are the sum of daily estimates. */
  async stats(siteId: string) {
    const now = this.clock.now();
    const [last7Days, last30Days] = await Promise.all([
      this.repository.totals(siteId, firstDayOf(now, 7)),
      this.repository.totals(siteId, firstDayOf(now, 30)),
    ]);
    return { last7Days, last30Days };
  }
}
