import { createHash, createHmac } from 'node:crypto';
import { type Clock, type SiteViewBeacon, SiteViewed, verifySiteViewToken } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import { dayOf, firstDayOf, hourOf } from '../domain/views.ts';
import {
  SITE_VIEW_COUNTER,
  SITE_VIEW_SECRET,
  SITE_VIEWS_REPOSITORY,
  type SiteViewCounter,
  type SiteViewsRepository,
} from './ports.ts';

/** How many (day, site) pairs and hours one flush handles (the next one continues). */
const FLUSH_BATCH = 1_000;

/**
 * The anonymous view beacon of published pages (BF-035): the token names the site (signed by the renderer), the
 * visitor is a daily-salted hash of IP and user agent. Nothing about the visitor is stored: only counters and the
 * HyperLogLog of hashes, whose salt changes every day.
 */
@Injectable()
export class SiteViewRecorder {
  constructor(
    @Inject(SITE_VIEW_COUNTER) private readonly counter: SiteViewCounter,
    @Inject(SITE_VIEW_SECRET) private readonly secret: string | undefined,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Counts a view; returns whether it was counted (an invalid token or no configuration counts nothing). */
  async record(beacon: SiteViewBeacon, visitor: { ip: string | undefined; userAgent: string | undefined }) {
    if (!this.secret) return false;
    const siteId = await verifySiteViewToken(beacon.token, this.secret);
    if (!siteId) return false;
    const now = this.clock.now();
    const day = dayOf(now);
    // The day's salt is derived from the secret: no salt is stored, and yesterday's hashes cannot be recomputed today.
    const salt = createHmac('sha256', this.secret).update(`site-view-salt:${day}`).digest();
    const hash = createHash('sha256')
      .update(salt)
      .update(`${visitor.ip ?? ''}|${visitor.userAgent ?? ''}`)
      .digest('hex')
      .slice(0, 32);
    await this.counter.record({
      siteId,
      day,
      hour: hourOf(now),
      visitor: hash,
      locale: beacon.locale,
      campaign: beacon.c,
    });
    return true;
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

  async flush(): Promise<{ days: number; events: number }> {
    const days = await this.counter.takeDays(FLUSH_BATCH);
    let written = 0;
    try {
      written = await this.repository.upsertDays(days);
    } catch (error) {
      await this.counter.returnDays(days);
      throw error;
    }
    let emitted = 0;
    const hours = await this.counter.completedHours(hourOf(this.clock.now()), FLUSH_BATCH);
    const refs = new Map(
      (await this.repository.refs([...new Set(hours.map((hour) => hour.siteId))])).map((ref) => [
        ref.id,
        ref,
      ]),
    );
    for (const hour of hours) {
      const ref = refs.get(hour.siteId);
      try {
        if (ref && hour.pageViews > 0) {
          await this.emit(ref, hour);
          emitted += 1;
        }
        await this.counter.forgetHour(hour.siteId, hour.hour);
      } catch (error) {
        this.logger.error({ err: error, siteId: hour.siteId, hour: hour.hour }, 'site.viewed not recorded');
      }
    }
    return { days: written, events: emitted };
  }

  @Transactional()
  private async emit(
    ref: { organizationId: string; businessId: string; id: string },
    hour: { hour: string; pageViews: number; uniqueEstimate: number },
  ): Promise<void> {
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
  }

  /** A site's views over the last 7 and 30 days (today included). */
  async stats(siteId: string) {
    const now = this.clock.now();
    const [last7Days, last30Days] = await Promise.all([
      this.repository.totals(siteId, firstDayOf(now, 7)),
      this.repository.totals(siteId, firstDayOf(now, 30)),
    ]);
    return { last7Days, last30Days };
  }
}
