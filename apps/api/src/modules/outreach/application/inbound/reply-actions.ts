import { type Clock, type DomainEvent, OutreachReplyReceived, OutreachReplyTriaged } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ComplianceService } from '../../../compliance/index.ts';
import { CrmPipeline } from '../../../crm/index.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { OnDomainEvent } from '../../../platform/events/on-domain-event.decorator.ts';
import { NotificationService } from '../../../realtime/index.ts';
import { replyActions } from '../../domain/inbound/action-policy.ts';
import { INBOUND_REPOSITORY, type InboundRepository } from './ports.ts';

// What a reply sets in motion (BF-054, idempotent subscribers over the deterministic policy):
// - on receipt, for every human reply: the business's owner (or the team) is notified — whatever triage says later;
// - on triage (or a person's correction): suppression for an unsubscribe the detector missed, `engaged` and a task
//   to answer for interest or a question, a follow-up task for "not now", a task for a referral. "Negative" only
//   suggests marking the business lost (the inbox shows it). Sequences stopped on receipt (BF-053's subscriber).

const MONTH_MS = 30 * 86_400_000;

@Injectable()
export class ReplyActions {
  constructor(
    @Inject(INBOUND_REPOSITORY) private readonly inbound: InboundRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly compliance: ComplianceService,
    private readonly crm: CrmPipeline,
    private readonly notifications: NotificationService,
  ) {}

  @OnDomainEvent(OutreachReplyReceived, { id: 'outreach.reply-notify' })
  async received(event: DomainEvent<typeof OutreachReplyReceived>): Promise<void> {
    if (!event.orgId || event.payload.kind !== 'human') return;
    const context = await this.inbound.triageContext(event.payload.inboundId);
    if (!context) return;
    const owner = await this.crm.ownerOf(event.orgId, context.businessId);
    await this.notifications.notify({
      organizationId: event.orgId,
      recipients: owner ? [owner] : 'members',
      type: 'reply_received',
      params: { business: context.businessName.slice(0, 200) },
      entity: { type: 'email_thread', id: event.payload.threadId },
      link: `/outreach/inbox?thread=${event.payload.threadId}`,
      sourceEventId: event.id,
    });
  }

  @OnDomainEvent(OutreachReplyTriaged, { id: 'outreach.reply-actions' })
  async triaged(event: DomainEvent<typeof OutreachReplyTriaged>): Promise<void> {
    const orgId = event.orgId;
    if (!orgId) return;
    const row = await this.inbound.byId(event.payload.inboundId);
    if (!row) return;
    const { businessId } = event.payload;
    const actions = replyActions({
      kind: row.kind,
      unsubscribeDetected: row.unsubscribeDetected,
      triage: {
        class: event.payload.class,
        confidence: event.payload.confidence,
        injectionSuspected: event.payload.corrected ? false : (row.triage?.injectionSuspected ?? false),
        followUpOn: row.triage?.entities.followUpOn ?? null,
      },
      autoReplyUntil: row.autoReplyUntil,
    });
    const owner = await this.crm.ownerOf(orgId, businessId);
    const who = row.fromName ?? row.fromEmail ?? 'the prospect';
    const today = this.clock.now();
    for (const action of actions) {
      switch (action.kind) {
        case 'suppress':
          if (row.fromEmail)
            await this.compliance.suppress({
              organizationId: orgId,
              scope: 'email',
              value: row.fromEmail,
              reason: 'unsubscribe',
              source: 'reply',
              actor: { type: 'system', id: 'outreach.reply' },
              note: `Reply ${row.id} (${event.payload.class})`,
            });
          break;
        case 'pipeline_engaged':
          await this.crm.markEngaged(orgId, businessId);
          break;
        case 'task_reply':
          await this.crm.followUp(orgId, businessId, {
            title: `Reply to ${who}`.slice(0, 200),
            type: 'email',
            dueAt: today,
            assigneeId: owner,
          });
          break;
        case 'task_follow_up':
          await this.crm.followUp(orgId, businessId, {
            title: `Follow up with ${who}`.slice(0, 200),
            type: 'follow_up',
            dueAt: action.on
              ? new Date(`${action.on}T09:00:00Z`)
              : new Date(today.getTime() + action.inMonths * MONTH_MS),
            assigneeId: owner,
          });
          break;
        case 'task_referral': {
          const referral = row.triage?.entities.referral;
          const target = [referral?.name, referral?.role, referral?.email].filter(Boolean).join(', ');
          await this.crm.followUp(orgId, businessId, {
            title: (target
              ? `Contact the referral: ${target}`
              : `Contact the person ${who} referred you to`
            ).slice(0, 200),
            type: 'follow_up',
            dueAt: today,
            assigneeId: owner,
          });
          break;
        }
        default:
          // notify (on receipt), suggest_lost and suggest_reply (shown in the inbox), reschedule_sequences (BF-053).
          break;
      }
    }
  }
}
