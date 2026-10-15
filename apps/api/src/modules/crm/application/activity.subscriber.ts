import {
  BusinessCreated,
  BusinessMerged,
  BusinessUpdated,
  CRM_ACTIVITY_CREATED,
  type DomainEvent,
  DoNotContactSet,
  NoteAdded,
  newId,
  OrgBusinessOwnerChanged,
  OrgBusinessStatusChanged,
  OrgBusinessTagsChanged,
  TaskCompleted,
  TaskCreated,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { type AnyEventDefinition, OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { RealtimePublisher } from '../../realtime/index.ts';
import { CRM_REPOSITORY, type CrmRepository } from './ports.ts';

type AnyDomainEvent = DomainEvent<AnyEventDefinition>;

/** Event type → activity type and the data the timeline shows (built-in renderers in the web app). */
const ACTIVITY_OF: Record<
  string,
  (payload: Record<string, unknown>) => { type: string; data: Record<string, unknown> }
> = {
  [OrgBusinessStatusChanged.type]: (p) => ({
    type: 'status.changed',
    data: { from: p.from, to: p.to, reason: p.reason, automatic: p.automatic },
  }),
  [OrgBusinessOwnerChanged.type]: (p) => ({ type: 'owner.changed', data: { ownerUserId: p.ownerUserId } }),
  [OrgBusinessTagsChanged.type]: (p) => ({
    type: 'tags.changed',
    data: { added: p.added, removed: p.removed },
  }),
  [DoNotContactSet.type]: (p) => ({
    type: 'do_not_contact.changed',
    data: { doNotContact: p.doNotContact, reason: p.reason },
  }),
  [NoteAdded.type]: (p) => ({ type: 'note.added', data: { noteId: p.noteId } }),
  [TaskCreated.type]: (p) => ({
    type: 'task.created',
    data: { taskId: p.taskId, title: p.title, dueAt: p.dueAt },
  }),
  [TaskCompleted.type]: (p) => ({ type: 'task.completed', data: { taskId: p.taskId, title: p.title } }),
  [BusinessCreated.type]: (p) => ({ type: 'business.tracked', data: { source: p.source } }),
};

/**
 * The activity timeline (BF-024, Observer): domain events become `activities` rows of the workspace that caused
 * them, idempotently (one row per event), and the detail page hears about them in realtime. Merges move a
 * business's notes, tasks and activities to the survivor.
 */
@Injectable()
export class ActivitySubscriber {
  constructor(
    @Inject(CRM_REPOSITORY) private readonly repository: CrmRepository,
    private readonly realtime: RealtimePublisher,
  ) {}

  @OnDomainEvent(
    [
      OrgBusinessStatusChanged,
      OrgBusinessOwnerChanged,
      OrgBusinessTagsChanged,
      DoNotContactSet,
      NoteAdded,
      TaskCreated,
      TaskCompleted,
      BusinessCreated,
    ],
    { id: 'crm.activity-timeline' },
  )
  async record(event: AnyDomainEvent): Promise<void> {
    if (!event.orgId) return;
    const payload = event.payload as Record<string, unknown>;
    const map = ACTIVITY_OF[event.type];
    if (!map) return;
    const { type, data } = map(payload);
    await this.add(event.orgId, String(payload.businessId), type, data, event);
  }

  /** Facts of the business changed (enrichment, a provider refresh): global, so every tracking workspace sees it. */
  @OnDomainEvent(BusinessUpdated, { id: 'crm.business-updated' })
  async updated(event: AnyDomainEvent): Promise<void> {
    const { businessId, fields } = event.payload as { businessId: string; fields: string[] };
    for (const organizationId of await this.repository.workspacesTracking(businessId))
      await this.add(organizationId, businessId, 'business.updated', { fields }, event);
  }

  @OnDomainEvent(BusinessMerged, { id: 'crm.merge-repoint' })
  async merged(event: AnyDomainEvent): Promise<void> {
    const { businessId, intoId } = event.payload as { businessId: string; intoId: string };
    await this.repository.repointMerged(businessId, intoId);
    for (const organizationId of await this.repository.workspacesTracking(intoId)) {
      await this.repository.refreshCounters(organizationId, intoId);
      await this.add(organizationId, intoId, 'business.merged', { mergedId: businessId }, event);
    }
  }

  private async add(
    organizationId: string,
    businessId: string,
    type: string,
    data: Record<string, unknown>,
    event: AnyDomainEvent,
  ): Promise<void> {
    const id = newId();
    const inserted = await this.repository.insertActivity({
      id,
      organizationId,
      businessId: businessId as never,
      type,
      actor: event.actor,
      data,
      occurredAt: new Date(event.occurredAt),
      sourceEventId: event.id,
    });
    if (!inserted) return;
    await this.realtime.publish(organizationId, {
      type: CRM_ACTIVITY_CREATED,
      entity: 'business',
      entityId: businessId,
      payload: { activityId: id, type },
    });
  }
}
