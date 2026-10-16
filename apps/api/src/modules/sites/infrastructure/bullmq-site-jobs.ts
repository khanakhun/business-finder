import {
  type Clock,
  type OrgId,
  type SiteId,
  SitesAssetAnalyzeJob,
  SitesAssetCollectJob,
  SitesAssetProcessJob,
  SitesExpireJob,
  SitesRevalidateJob,
  SitesScreenshotJob,
  SitesViewsFlushJob,
} from '@bf/contracts';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import type {
  AssetProcessingQueue,
  AssetSourcingQueue,
  SiteRevalidation,
  SiteScreenshotQueue,
} from '../application/ports.ts';

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

@Injectable()
export class BullmqAssetProcessingQueue implements AssetProcessingQueue {
  private readonly jobs: TypedProducer<typeof SitesAssetProcessJob>;

  constructor(@InjectQueue(QUEUES.sitesAssetProcess.name) queue: Queue) {
    this.jobs = new TypedProducer(queue, SitesAssetProcessJob);
  }

  async process(assetId: string, organizationId: string): Promise<void> {
    await this.jobs.add({
      orgId: organizationId as OrgId,
      idempotencyKey: `asset-process:${assetId}`,
      assetId,
    });
  }
}

/** Collections are one job per site and hour (a second refresh within the hour is the same job); analyses once. */
@Injectable()
export class BullmqAssetSourcingQueue implements AssetSourcingQueue {
  private readonly collects: TypedProducer<typeof SitesAssetCollectJob>;
  private readonly analyses: TypedProducer<typeof SitesAssetAnalyzeJob>;

  constructor(
    @InjectQueue(QUEUES.sitesAssetCollect.name) collect: Queue,
    @InjectQueue(QUEUES.sitesAssetAnalyze.name) analyze: Queue,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.collects = new TypedProducer(collect, SitesAssetCollectJob);
    this.analyses = new TypedProducer(analyze, SitesAssetAnalyzeJob);
  }

  async collect(organizationId: string, siteId: string): Promise<void> {
    const hour = this.clock.now().toISOString().slice(0, 13);
    await this.collects.add({
      orgId: organizationId as OrgId,
      idempotencyKey: `asset-collect:${siteId}:${hour}`,
      organizationId,
      siteId: siteId as SiteId,
    });
  }

  async analyze(assetId: string, organizationId: string): Promise<void> {
    await this.analyses.add({
      orgId: organizationId as OrgId,
      idempotencyKey: `asset-analyze:${assetId}`,
      assetId,
    });
  }
}

export const OPENAPI_SOURCING_QUEUE: AssetSourcingQueue = {
  collect: async () => {},
  analyze: async () => {},
};

/** How long after a publication its pictures are taken (the renderer's revalidation runs first); tests set 0. */
export const SCREENSHOT_DELAY_MS = Symbol('ScreenshotDelayMs');

@Injectable()
export class BullmqSiteScreenshotQueue implements SiteScreenshotQueue {
  private readonly jobs: TypedProducer<typeof SitesScreenshotJob>;

  constructor(
    @InjectQueue(QUEUES.sitesScreenshot.name) queue: Queue,
    @Inject(SCREENSHOT_DELAY_MS) private readonly delayMs: number,
  ) {
    this.jobs = new TypedProducer(queue, SitesScreenshotJob);
  }

  async capture(input: Parameters<SiteScreenshotQueue['capture']>[0]): Promise<void> {
    await this.jobs.add(
      {
        orgId: input.organizationId as OrgId,
        idempotencyKey: input.idempotencyKey,
        siteId: input.siteId as SiteId,
        publicationId: input.publicationId,
      },
      // The same event refreshes the renderer: photograph the new page, not the cached one.
      { delay: this.delayMs },
    );
  }
}

/** OpenAPI generation boots without Valkey. */
export const OPENAPI_ASSET_QUEUE: AssetProcessingQueue = { process: async () => {} };
export const OPENAPI_SCREENSHOT_QUEUE: SiteScreenshotQueue = { capture: async () => {} };

export const SITES_VIEWS_AUTOSTART = Symbol('SitesViewsAutostart');
/** Views are moved from Valkey to the database every 5 minutes. */
const FLUSH_MS = 5 * 60_000;

/** Enqueues one views flush per 5-minute slot (the job id is per slot), in the worker only. */
@Injectable()
export class SitesViewsFlushScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly jobs: TypedProducer<typeof SitesViewsFlushJob>;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @InjectQueue(QUEUES.sitesViews.name) queue: Queue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(SITES_VIEWS_AUTOSTART) private readonly autostart: boolean,
  ) {
    this.jobs = new TypedProducer(queue, SitesViewsFlushJob);
  }

  onApplicationBootstrap(): void {
    if (!this.autostart) return;
    const run = () =>
      this.tick().catch((error: unknown) =>
        this.logger.error({ err: error }, 'site views flush scheduling failed'),
      );
    this.timer = setInterval(run, FLUSH_MS / 5);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const slot = Math.floor(this.clock.now().getTime() / FLUSH_MS);
    await this.jobs.add({ orgId: null, idempotencyKey: `sites-views:${slot}` });
  }
}
