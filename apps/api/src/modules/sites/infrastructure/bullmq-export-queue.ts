import { type OrgId, SitesExportJob } from '@bf/contracts';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { SiteExportQueue } from '../application/go-live/export.service.ts';

/** Static export jobs (BF-062): one per export, keyed by its id. */
@Injectable()
export class BullmqSiteExportQueue implements SiteExportQueue {
  private readonly jobs: TypedProducer<typeof SitesExportJob>;

  constructor(@InjectQueue(QUEUES.sitesExport.name) queue: Queue) {
    this.jobs = new TypedProducer(queue, SitesExportJob);
  }

  async enqueue(input: Parameters<SiteExportQueue['enqueue']>[0]): Promise<void> {
    await this.jobs.add({
      orgId: input.organizationId as OrgId,
      idempotencyKey: `sites-export:${input.exportId}`,
      exportId: input.exportId,
    });
  }
}

export const OPENAPI_EXPORT_QUEUE: SiteExportQueue = { enqueue: async () => {} };
