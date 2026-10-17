import {
  type Clock,
  ContactSuppressed,
  type DomainEvent,
  OrgBusinessStatusChanged,
  OutreachMessageBlocked,
  OutreachMessageBounced,
  OutreachMessageCancelled,
  OutreachMessageFailed,
  OutreachMessageSent,
  OutreachReplyReceived,
  OutreachReplyTriaged,
  SiteLeadCaptured,
  type StopReason,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { OnDomainEvent } from '../../../platform/events/on-domain-event.decorator.ts';
import { WorkspaceDefaults } from '../../../workspace/index.ts';
import { addBusinessDays, nextRunAt } from '../../domain/sequences/business-calendar.ts';
import { STOP_PIPELINE } from '../../domain/sequences/stop-policy.ts';
import { EnrollmentsService } from './enrollments.service.ts';
import { SequenceExecutor } from './executor.ts';
import { type EnrollmentRecord, SEQUENCE_REPOSITORY, type SequenceRepository } from './ports.ts';

// Sequences react between ticks (BF-053, idempotent subscribers): nothing waits for the next minute.
// - A human reply pauses the business's enrollment at once (no further step can send); its triage then stops it —
//   or, for an out-of-office, resumes it after the return date (+1 business day; +5 when unknown).
// - A bounce, a business-level suppression, a preview lead or a pipeline move into the stop set stops it.
// - The message a step waits for: sent → the next step is scheduled; cancelled (undone, rejected) → the step is
//   skipped; blocked at send → stopped; failed for good → paused for a person.

const OOO_DEFAULT_DAYS = 5;

@Injectable()
export class SequenceSubscribers {
  constructor(
    @Inject(SEQUENCE_REPOSITORY) private readonly repository: SequenceRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly enrollments: EnrollmentsService,
    private readonly executor: SequenceExecutor,
    private readonly workspace: WorkspaceDefaults,
  ) {}

  private async stopAll(orgId: string | null, businessId: string, reason: StopReason, detail: string) {
    if (!orgId) return;
    for (const enrollment of await this.repository.running(orgId, businessId))
      await this.enrollments.stopWith(enrollment.id, reason, detail);
  }

  @OnDomainEvent(OutreachReplyReceived, { id: 'outreach.sequences-on-reply' })
  async onReply(event: DomainEvent<typeof OutreachReplyReceived>): Promise<void> {
    if (!event.orgId) return;
    const { businessId, kind, autoReplyUntil } = event.payload;
    for (const enrollment of await this.repository.running(event.orgId, businessId)) {
      if (kind === 'auto_reply') await this.reschedule(enrollment, autoReplyUntil);
      else if (kind === 'human' || kind === 'unsubscribe_mailto') {
        // Paused at once; the triage decides between stopping and resuming (an out-of-office misread as human).
        const paused = await this.repository.transition(enrollment.id, ['active'], 'paused', {
          pauseReason: 'reply_received',
          leaseUntil: null,
        });
        if (paused)
          await this.repository.addEvent({
            enrollmentId: enrollment.id,
            kind: 'paused',
            stepId: null,
            variantId: null,
            detail: 'reply received',
            messageId: null,
          });
      }
    }
  }

  @OnDomainEvent(OutreachReplyTriaged, { id: 'outreach.sequences-on-triage' })
  async onTriage(event: DomainEvent<typeof OutreachReplyTriaged>): Promise<void> {
    if (!event.orgId) return;
    const { businessId } = event.payload;
    const triageClass = event.payload.class;
    for (const enrollment of await this.repository.running(event.orgId, businessId)) {
      if (
        triageClass === 'auto_reply' &&
        enrollment.status === 'paused' &&
        enrollment.pauseReason === 'reply_received'
      ) {
        const resumed = await this.repository.transition(enrollment.id, ['paused'], 'active', {
          pauseReason: null,
        });
        if (resumed) await this.reschedule(resumed, null);
        continue;
      }
      if (triageClass !== 'auto_reply')
        await this.enrollments.stopWith(
          enrollment.id,
          triageClass === 'unsubscribe' || event.payload.unsubscribeDetected ? 'unsubscribed' : 'replied',
          `reply: ${triageClass}`,
        );
    }
  }

  @OnDomainEvent(OutreachMessageBounced, { id: 'outreach.sequences-on-bounce' })
  async onBounce(event: DomainEvent<typeof OutreachMessageBounced>): Promise<void> {
    if (event.payload.permanent)
      await this.stopAll(event.orgId, event.payload.businessId, 'bounced', 'hard bounce');
  }

  @OnDomainEvent(ContactSuppressed, { id: 'outreach.sequences-on-suppressed' })
  async onSuppressed(event: DomainEvent<typeof ContactSuppressed>): Promise<void> {
    // Address-level suppressions are caught by the step's compliance check; business-level ones stop at once.
    if (event.payload.businessId)
      await this.stopAll(event.orgId, event.payload.businessId, 'suppressed', event.payload.reason);
  }

  @OnDomainEvent(SiteLeadCaptured, { id: 'outreach.sequences-on-lead' })
  async onLead(event: DomainEvent<typeof SiteLeadCaptured>): Promise<void> {
    if (!event.orgId) return;
    for (const enrollment of await this.repository.running(event.orgId, event.payload.businessId)) {
      const version = await this.repository.versionById(enrollment.sequenceVersionId);
      if (version?.settings.stopOnPreviewLead ?? true)
        await this.enrollments.stopWith(enrollment.id, 'converted', 'lead from the preview');
    }
  }

  @OnDomainEvent(OrgBusinessStatusChanged, { id: 'outreach.sequences-on-status' })
  async onStatus(event: DomainEvent<typeof OrgBusinessStatusChanged>): Promise<void> {
    if ((STOP_PIPELINE as readonly string[]).includes(event.payload.to))
      await this.stopAll(
        event.orgId,
        event.payload.businessId,
        'pipeline_changed',
        `moved to ${event.payload.to}`,
      );
  }

  @OnDomainEvent(OutreachMessageSent, { id: 'outreach.sequences-on-sent' })
  async onSent(event: DomainEvent<typeof OutreachMessageSent>): Promise<void> {
    const enrollment = await this.waiting(event.payload.messageId);
    if (!enrollment) return;
    await this.next(enrollment, 'executed', 'sent');
  }

  @OnDomainEvent(OutreachMessageCancelled, { id: 'outreach.sequences-on-cancelled' })
  async onCancelled(event: DomainEvent<typeof OutreachMessageCancelled>): Promise<void> {
    const enrollment = await this.waiting(event.payload.messageId);
    if (!enrollment) return;
    await this.next(enrollment, 'skipped', 'email cancelled or rejected');
  }

  @OnDomainEvent(OutreachMessageBlocked, { id: 'outreach.sequences-on-blocked' })
  async onBlocked(event: DomainEvent<typeof OutreachMessageBlocked>): Promise<void> {
    const enrollment = await this.waiting(event.payload.messageId);
    if (enrollment)
      await this.enrollments.stopWith(
        enrollment.id,
        'compliance_blocked',
        event.payload.reasons.join(', ') || null,
      );
  }

  @OnDomainEvent(OutreachMessageFailed, { id: 'outreach.sequences-on-failed' })
  async onFailed(event: DomainEvent<typeof OutreachMessageFailed>): Promise<void> {
    if (!event.payload.final) return;
    const enrollment = await this.waiting(event.payload.messageId);
    if (enrollment)
      await this.executor.pause(
        enrollment,
        'send_failed',
        `The email could not be sent (${event.payload.code}).`,
      );
  }

  private async waiting(messageId: string) {
    const enrollment = await this.repository.byWaitingMessage(messageId);
    return enrollment && enrollment.status === 'active' ? enrollment : undefined;
  }

  private async next(enrollment: EnrollmentRecord, kind: 'executed' | 'skipped', detail: string) {
    const version = await this.repository.versionById(enrollment.sequenceVersionId);
    const step = version?.steps[enrollment.currentStepIndex];
    if (!version || !step) return;
    await this.executor.advance(enrollment, version, null, kind, step, detail);
  }

  /** After an out-of-office: the day after the return date (or five business days), at the step's time. */
  private async reschedule(enrollment: EnrollmentRecord, returnDate: string | null) {
    if (enrollment.waitingMessageId) return;
    const version = await this.repository.versionById(enrollment.sequenceVersionId);
    if (!version) return;
    const step = version.steps[enrollment.currentStepIndex];
    const timeZone = await this.workspace.timeZone(enrollment.organizationId);
    const from = returnDate
      ? new Date(`${addBusinessDays(returnDate, 1, version.settings.calendars)}T08:00:00Z`)
      : this.clock.now();
    const at = nextRunAt({
      from,
      businessDays: returnDate ? 0 : OOO_DEFAULT_DAYS,
      preferredLocalTime: step?.wait.preferredLocalTime ?? null,
      timeZone,
      calendars: version.settings.calendars,
    });
    if (enrollment.nextRunAt && enrollment.nextRunAt.getTime() >= at.getTime()) return;
    await this.repository.updateEnrollment(enrollment.id, { nextRunAt: at });
    await this.repository.addEvent({
      enrollmentId: enrollment.id,
      kind: 'rescheduled',
      stepId: step?.id ?? null,
      variantId: null,
      detail: returnDate ? `out of office until ${returnDate}` : 'out of office',
      messageId: null,
    });
  }
}
