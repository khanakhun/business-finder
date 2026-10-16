import { type Clock, type SiteId, SitesExpireJob, SitesRevalidateJob } from '@bf/contracts';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import type { SiteRevalidation } from '../application/ports.ts';

/** Revalidations go through a job: retried with backoff while the renderer is down. */
@Injectable()
export class BullmqSiteRevalidation implements SiteRevalidation {
  private readonly jobs: TypedProducer<typeof SitesRevalidateJob>;

  constructor(@InjectQueue(QUEUES.sitesRevalidate.name) queue: Queue) {
    this.jobs = new TypedProducer(queue, SitesRevalidateJob);
  }

  async revalidate(input: Parameters<SiteRevalidation['revalidate']>[0]): Promise<void> {
    await this.jobs.add({
      orgId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      siteId: input.siteId as SiteId,
      tags: input.tags,
    });
  }
}

/** OpenAPI generation boots without Valkey: nothing is enqueued there. */
export const OPENAPI_SITE_REVALIDATION: SiteRevalidation = { revalidate: async () => {} };

export const SITES_EXPIRY_AUTOSTART = Symbol('SitesExpiryAutostart');
/** How often the worker checks whether this hour's expiry job is queued. */
const CHECK_MS = 5 * 60_000;

/**
 * Enqueues the preview expiry once per hour (the job id is per UTC hour: workers checking at the same time enqueue
 * one job). Runs in the worker only.
 */
@Injectable()
export class SitesExpiryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly jobs: TypedProducer<typeof SitesExpireJob>;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @InjectQueue(QUEUES.sitesExpire.name) queue: Queue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(SITES_EXPIRY_AUTOSTART) private readonly autostart: boolean,
  ) {
    this.jobs = new TypedProducer(queue, SitesExpireJob);
  }

  onApplicationBootstrap(): void {
    if (!this.autostart) return;
    const run = () =>
      this.tick().catch((error: unknown) =>
        this.logger.error({ err: error }, 'site expiry scheduling failed'),
      );
    void run();
    this.timer = setInterval(run, CHECK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Queues this hour's expiry job (once per hour, whatever the number of calls). */
  async tick(): Promise<void> {
    const hour = this.clock.now().toISOString().slice(0, 13);
    await this.jobs.add({ orgId: null, idempotencyKey: `sites-expire:${hour}` });
  }
}
