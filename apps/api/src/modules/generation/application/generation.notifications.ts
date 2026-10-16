import { type DomainEvent, GenerationBatchCompleted, GenerationJobStatusChanged } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { NotificationService } from '../../realtime/index.ts';
import { GENERATION_REPOSITORY, type GenerationRepository } from './ports.ts';

/** Tells whoever started a batch that it finished, and that a generated site needs review (BF-012 notifications). */
@Injectable()
export class GenerationNotifications {
  constructor(
    private readonly notifications: NotificationService,
    @Inject(GENERATION_REPOSITORY) private readonly repository: GenerationRepository,
  ) {}

  @OnDomainEvent(GenerationBatchCompleted, { id: 'generation.notify-batch-completed' })
  async batchCompleted(event: DomainEvent<typeof GenerationBatchCompleted>): Promise<void> {
    const { batchId, createdBy, status, succeeded, total } = event.payload;
    if (!event.orgId || !createdBy) return;
    await this.notifications.notify({
      organizationId: event.orgId,
      recipients: [createdBy],
      type: 'batch_completed',
      params: { count: succeeded, total, status },
      entity: { type: 'generation_batch', id: batchId },
      link: `/generation/${batchId}`,
      sourceEventId: event.id,
    });
  }

  @OnDomainEvent(GenerationJobStatusChanged, { id: 'generation.notify-needs-review' })
  async needsReview(event: DomainEvent<typeof GenerationJobStatusChanged>): Promise<void> {
    if (event.payload.to !== 'needs_review' || !event.orgId) return;
    const job = await this.repository.jobById(event.payload.jobId);
    const batch = job ? await this.repository.batchById(job.batchId) : undefined;
    if (!job || !batch?.createdBy) return;
    await this.notifications.notify({
      organizationId: event.orgId,
      recipients: [batch.createdBy],
      type: 'site_needs_review',
      params: {
        business: job.businessName.slice(0, 120),
        reason: (job.errorCode ?? 'QUALITY_GATES').toLowerCase(),
      },
      entity: { type: 'generation_job', id: job.id },
      link: job.siteId ? `/sites/${job.siteId}/edit` : `/generation/${job.batchId}`,
      sourceEventId: event.id,
    });
  }
}
