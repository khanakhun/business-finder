import {
  type DomainEvent,
  OUTREACH_MESSAGE_STATUS,
  OutreachMessageBlocked,
  OutreachMessageCancelled,
  OutreachMessageFailed,
  OutreachMessageQueued,
  OutreachMessageSent,
} from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { CrmPipeline } from '../../../crm/index.ts';
import {
  type AnyEventDefinition,
  OnDomainEvent,
} from '../../../platform/events/on-domain-event.decorator.ts';
import { RealtimePublisher } from '../../../realtime/index.ts';

type AnyDomainEvent = DomainEvent<AnyEventDefinition>;

const STATUS_OF: Record<string, string> = {
  [OutreachMessageQueued.type]: 'queued',
  [OutreachMessageSent.type]: 'sent',
  [OutreachMessageFailed.type]: 'failed',
  [OutreachMessageBlocked.type]: 'blocked',
  [OutreachMessageCancelled.type]: 'cancelled',
};

/**
 * Side effects of the outbound pipeline (BF-052, idempotent outbox subscribers): the first message sent moves the
 * business to `contacted` (qualifying a `new` one on the way), and every status change reaches the open pages
 * (status chips, outbox, business activity). The timeline entries are the CRM's activity subscriber's.
 */
@Injectable()
export class OutboundSubscribers {
  constructor(
    private readonly crm: CrmPipeline,
    private readonly realtime: RealtimePublisher,
  ) {}

  @OnDomainEvent(OutreachMessageSent, { id: 'outreach.crm-contacted' })
  async contacted(event: DomainEvent<typeof OutreachMessageSent>): Promise<void> {
    if (!event.orgId) return;
    await this.crm.markContacted(event.orgId, event.payload.businessId);
  }

  @OnDomainEvent(
    [
      OutreachMessageQueued,
      OutreachMessageSent,
      OutreachMessageFailed,
      OutreachMessageBlocked,
      OutreachMessageCancelled,
    ],
    { id: 'outreach.message-realtime' },
  )
  async status(event: AnyDomainEvent): Promise<void> {
    if (!event.orgId) return;
    const payload = event.payload as { messageId: string; businessId: string };
    await this.realtime.publish(event.orgId, {
      type: OUTREACH_MESSAGE_STATUS,
      entity: 'outbound_message',
      entityId: payload.messageId,
      payload: { status: STATUS_OF[event.type], businessId: payload.businessId },
    });
  }
}
