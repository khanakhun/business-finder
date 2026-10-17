import {
  type Clock,
  ConflictError,
  type DomainEvent,
  type MailboxStatus,
  MailboxStatusChanged,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { EventRecorder } from '../../../platform/events/event-recorder.ts';
import { OnDomainEvent } from '../../../platform/events/on-domain-event.decorator.ts';
import { NotificationService } from '../../../realtime/index.ts';
import { rampComplete } from '../../domain/mailbox/capacity-policy.ts';
import { assertTransition } from '../../domain/mailbox/mailbox-state-machine.ts';
import { MAILBOX_REPOSITORY, type MailboxRecord, type MailboxRepository } from './ports.ts';

// The mailbox lifecycle (DOMAIN §3.7) as one place: a typed transition, its trail row, the `mailbox.status.changed`
// event (outbox) and — for pauses and errors — the owner's notification (a subscriber, safe to repeat).

export interface TransitionInput {
  readonly reason: string | null;
  /** Decided by the system (health check, thresholds) rather than a person. */
  readonly automatic: boolean;
  readonly actorUserId: string | null;
}

@Injectable()
export class MailboxLifecycle {
  constructor(
    @Inject(MAILBOX_REPOSITORY) private readonly repository: MailboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventRecorder,
    private readonly notifications: NotificationService,
  ) {}

  /** Call inside the use case's transaction (the event is recorded with it). */
  async transition(
    mailbox: MailboxRecord,
    to: MailboxStatus,
    input: TransitionInput,
  ): Promise<MailboxRecord> {
    if (mailbox.status === to) return mailbox;
    assertTransition(mailbox.status, to);
    if (
      !(await this.repository.setStatus(mailbox.organizationId, mailbox.id, mailbox.status, to, input.reason))
    )
      throw new ConflictError('The mailbox changed meanwhile; reload and try again.');
    await this.repository.addEvent(mailbox.organizationId, mailbox.id, {
      kind: 'status_changed',
      fromStatus: mailbox.status,
      toStatus: to,
      detail: { reason: input.reason, automatic: input.automatic },
      actorUserId: input.actorUserId,
    });
    await this.events.record(MailboxStatusChanged, {
      orgId: mailbox.organizationId,
      ...(input.automatic ? { actor: { type: 'system', id: 'outreach.mailboxes' } as const } : {}),
      payload: {
        mailboxId: mailbox.id,
        email: mailbox.email,
        from: mailbox.status,
        to,
        reason: input.reason,
        automatic: input.automatic,
      },
    });
    return { ...mailbox, status: to, statusReason: input.reason };
  }

  /** Where a mailbox goes when it may send again: warming while its ramp is climbing, else active. */
  sendingStatus(mailbox: MailboxRecord): MailboxStatus {
    return rampComplete(mailbox, this.clock.now()) ? 'active' : 'warming';
  }

  @OnDomainEvent(MailboxStatusChanged, { id: 'outreach.mailbox-notify' })
  async notify(event: DomainEvent<typeof MailboxStatusChanged>): Promise<void> {
    const { to, mailboxId, email, reason } = event.payload;
    if (!event.orgId || (to !== 'paused' && to !== 'error')) return;
    // A manual pause is the person's own action: no notification.
    if (to === 'paused' && !event.payload.automatic) return;
    const mailbox = await this.repository.find(event.orgId, mailboxId);
    await this.notifications.notify({
      organizationId: event.orgId,
      recipients: mailbox?.ownerUserId ? [mailbox.ownerUserId] : 'members',
      type: to === 'paused' ? 'mailbox_paused' : 'mailbox_error',
      params: { mailbox: email.slice(0, 200), reason: (reason ?? '').slice(0, 200) },
      entity: { type: 'mailbox', id: mailboxId },
      link: '/settings/mailboxes',
      sourceEventId: event.id,
    });
  }
}
