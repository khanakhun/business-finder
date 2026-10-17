import { type OrgId, OutreachBulkDraftJob } from '@bf/contracts';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { BulkQueue } from '../../application/outbound/ports.ts';

@Injectable()
export class BullmqBulkQueue implements BulkQueue {
  private readonly jobs: TypedProducer<typeof OutreachBulkDraftJob>;

  constructor(@InjectQueue(QUEUES.outreachBulk.name) queue: Queue) {
    this.jobs = new TypedProducer(queue, OutreachBulkDraftJob);
  }

  async draft(organizationId: string, runId: string, businessId: string): Promise<void> {
    await this.jobs.add({
      orgId: organizationId as OrgId,
      idempotencyKey: `bulk:${runId}:${businessId}`,
      runId,
      businessId,
    });
  }
}

/** OpenAPI generation boots without Valkey. */
export const OPENAPI_BULK_QUEUE: BulkQueue = { draft: async () => {} };
