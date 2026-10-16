import {
  BusinessCreated,
  BusinessEnriched,
  BusinessMerged,
  BusinessUpdated,
  DiscoveryRunCompleted,
  type DomainEvent,
  DoNotContactSet,
  OrgBusinessStatusChanged,
  OrgBusinessTracked,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { SCORING_QUEUE, SCORING_REPOSITORY, type ScoringQueue, type ScoringRepository } from './ports.ts';

/**
 * Keeps scores current (BF-031, Observer): what changes a business's facts enqueues a `scoring.compute` job, keyed
 * by the event (re-delivery enqueues nothing new). Facts shared by every workspace (golden record, crawl, audit,
 * contacts) recompute every workspace tracking the business; the workspace's own facts (pipeline, do-not-contact,
 * tracking) only that workspace.
 */
@Injectable()
export class ScoringSubscribers {
  constructor(
    @Inject(SCORING_REPOSITORY) private readonly repository: ScoringRepository,
    @Inject(SCORING_QUEUE) private readonly queue: ScoringQueue,
  ) {}

  /**
   * Shared facts changed: every workspace tracking the business recomputes. A merge recomputes the survivor (it
   * takes over the merged business's workspace rows); a split's new business arrives as `business.created` with the
   * workspace rows copied from the original.
   */
  @OnDomainEvent([BusinessEnriched, BusinessUpdated, BusinessCreated, BusinessMerged], {
    id: 'scoring.recompute-shared-facts',
  })
  async onSharedFacts(
    event:
      | DomainEvent<typeof BusinessEnriched>
      | DomainEvent<typeof BusinessUpdated>
      | DomainEvent<typeof BusinessCreated>
      | DomainEvent<typeof BusinessMerged>,
  ): Promise<void> {
    const businessId = 'intoId' in event.payload ? event.payload.intoId : event.payload.businessId;
    const tracking = await this.repository.workspacesTracking([businessId]);
    for (const [organizationId, businessIds] of tracking) {
      await this.queue.compute({
        organizationId,
        businessIds,
        idempotencyKey: `event:${event.id}:${organizationId}`,
      });
    }
  }

  /**
   * A discovery run scores what it added once it ends (one event per run: a per-business event in the ingest loop
   * would slow it down; DECISION(BF-031)).
   */
  @OnDomainEvent(DiscoveryRunCompleted, { id: 'scoring.score-discovered' })
  async onDiscovered(event: DomainEvent<typeof DiscoveryRunCompleted>): Promise<void> {
    if (!event.orgId) return;
    const businessIds = await this.repository.trackedByRun(event.orgId, event.payload.runId);
    if (businessIds.length === 0) return;
    await this.queue.compute({
      organizationId: event.orgId,
      businessIds,
      idempotencyKey: `event:${event.id}`,
    });
  }

  @OnDomainEvent([OrgBusinessTracked, OrgBusinessStatusChanged, DoNotContactSet], {
    id: 'scoring.recompute-workspace-facts',
  })
  async onWorkspaceFacts(
    event:
      | DomainEvent<typeof OrgBusinessTracked>
      | DomainEvent<typeof OrgBusinessStatusChanged>
      | DomainEvent<typeof DoNotContactSet>,
  ): Promise<void> {
    if (!event.orgId) return;
    await this.queue.compute({
      organizationId: event.orgId,
      businessIds: [event.payload.businessId],
      idempotencyKey: `event:${event.id}`,
    });
  }
}
