import { SitesExpireJob, SitesRevalidateJob } from '@bf/contracts';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import type { z } from 'zod';
import { TypedProcessor } from '../../../platform/queue/typed-processor.ts';
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
