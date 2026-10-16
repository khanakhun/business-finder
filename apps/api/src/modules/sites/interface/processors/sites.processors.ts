import {
  SitesAssetProcessJob,
  SitesExpireJob,
  SitesRevalidateJob,
  SitesScreenshotJob,
  SitesViewsFlushJob,
} from '@bf/contracts';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import type { z } from 'zod';
import { TypedProcessor } from '../../../platform/queue/typed-processor.ts';
import { SiteAssetCommands } from '../../application/site-assets.ts';
import { SiteThumbnailCommands } from '../../application/site-thumbnails.ts';
import { SiteViewsFlusher } from '../../application/site-views.ts';
import { SiteCommands } from '../../application/sites.commands.ts';
import { RendererRevalidator } from '../../infrastructure/renderer-revalidator.ts';

@Processor(QUEUES.sitesRevalidate.name, { concurrency: QUEUES.sitesRevalidate.concurrency })
export class SitesRevalidateProcessor extends TypedProcessor<
  typeof SitesRevalidateJob,
  { readonly outcome: string }
> {
  protected readonly definition = SitesRevalidateJob;

  constructor(private readonly revalidator: RendererRevalidator) {
    super();
  }

  async handle(payload: z.output<typeof SitesRevalidateJob.schema>, context: JobContext) {
    const outcome = await this.revalidator.revalidate({ tags: payload.tags }, context.signal);
    context.logger.debug({ siteId: payload.siteId, tags: payload.tags, outcome }, 'site revalidated');
    return { outcome };
  }
}

@Processor(QUEUES.sitesExpire.name, { concurrency: QUEUES.sitesExpire.concurrency })
export class SitesExpireProcessor extends TypedProcessor<
  typeof SitesExpireJob,
  { readonly expired: number }
> {
  protected readonly definition = SitesExpireJob;

  constructor(private readonly commands: SiteCommands) {
    super();
  }

  async handle(_payload: z.output<typeof SitesExpireJob.schema>, context: JobContext) {
    let expired = 0;
    // In batches until none is due (each preview ends in its own transaction), at most 20 per run (the next hour
    // continues; a preview that keeps failing is retried there and logged).
    for (let round = 0; round < 20 && !context.signal.aborted; round += 1) {
      const batch = await this.commands.expireDuePreviews();
      expired += batch;
      if (batch === 0) break;
    }
    if (expired > 0) context.logger.info({ expired }, 'previews expired');
    return { expired };
  }
}

@Processor(QUEUES.sitesAssetProcess.name, { concurrency: QUEUES.sitesAssetProcess.concurrency })
export class SitesAssetProcessProcessor extends TypedProcessor<
  typeof SitesAssetProcessJob,
  { readonly outcome: string }
> {
  protected readonly definition = SitesAssetProcessJob;

  constructor(private readonly assets: SiteAssetCommands) {
    super();
  }

  async handle(payload: z.output<typeof SitesAssetProcessJob.schema>, context: JobContext) {
    try {
      const outcome = await this.assets.process(payload.assetId);
      context.logger.info({ assetId: payload.assetId, outcome }, 'site asset processed');
      return { outcome };
    } catch (error) {
      // The last attempt: the image is failed (the member uploads it again), never left processing.
      if (context.attempt >= (QUEUES.sitesAssetProcess.defaultJobOptions.attempts ?? 1)) {
        await this.assets.fail(payload.assetId);
        context.logger.warn({ err: error, assetId: payload.assetId }, 'site asset processing failed');
        return { outcome: 'failed' };
      }
      throw error;
    }
  }
}

@Processor(QUEUES.sitesScreenshot.name, { concurrency: QUEUES.sitesScreenshot.concurrency })
export class SitesScreenshotProcessor extends TypedProcessor<
  typeof SitesScreenshotJob,
  { readonly outcome: string }
> {
  protected readonly definition = SitesScreenshotJob;

  constructor(private readonly thumbnails: SiteThumbnailCommands) {
    super();
  }

  async handle(payload: z.output<typeof SitesScreenshotJob.schema>, context: JobContext) {
    const outcome = await this.thumbnails.capture(payload.siteId, payload.publicationId, context.signal);
    context.logger.info(
      { siteId: payload.siteId, publicationId: payload.publicationId, outcome },
      'site screenshots',
    );
    return { outcome };
  }
}

@Processor(QUEUES.sitesViews.name, { concurrency: QUEUES.sitesViews.concurrency })
export class SitesViewsFlushProcessor extends TypedProcessor<
  typeof SitesViewsFlushJob,
  { readonly days: number; readonly events: number }
> {
  protected readonly definition = SitesViewsFlushJob;

  constructor(private readonly flusher: SiteViewsFlusher) {
    super();
  }

  async handle(_payload: z.output<typeof SitesViewsFlushJob.schema>, context: JobContext) {
    const result = await this.flusher.flush();
    if (result.days > 0 || result.events > 0) context.logger.info(result, 'site views flushed');
    return result;
  }
}
