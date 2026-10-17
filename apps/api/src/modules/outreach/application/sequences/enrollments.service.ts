import {
  type Clock,
  ConflictError,
  type Enrollment,
  EnrollmentStopped,
  type EnrollRequest,
  EnrollRequestSchema,
  type EnrollResult,
  NotFoundError,
  newId,
  type StopReason,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ComplianceService } from '../../../compliance/index.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { EventRecorder } from '../../../platform/events/event-recorder.ts';
import { WorkspaceDefaults } from '../../../workspace/index.ts';
import { nextRunAt } from '../../domain/sequences/business-calendar.ts';
import { assertEnrollmentTransition, RUNNING } from '../../domain/sequences/state-machine.ts';
import type { DraftActor } from '../drafting/drafts.service.ts';
import { OUTBOUND_REPOSITORY, type OutboundRepository } from '../outbound/ports.ts';
import {
  type EnrollmentRecord,
  SEQUENCE_REPOSITORY,
  type SequenceRepository,
  type SequenceVersionRecord,
} from './ports.ts';

// Enrollments (BF-053): a business follows an active sequence's head version. Each item is previewed by the
// compliance gate first (blocked ones are reported, not enrolled), and a business runs at most one sequence at a
// time. Attaching after a first email (`fromMessageId`) takes that message's contact, mailbox and thread, and starts
// after the sequence's first email step. Pause, resume and stop are audited; stopping says why.

@Injectable()
export class EnrollmentsService {
  constructor(
    @Inject(SEQUENCE_REPOSITORY) private readonly repository: SequenceRepository,
    @Inject(OUTBOUND_REPOSITORY) private readonly messages: OutboundRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly compliance: ComplianceService,
    private readonly workspace: WorkspaceDefaults,
    private readonly events: EventRecorder,
  ) {}

  async enroll(
    actor: DraftActor,
    sequenceId: string,
    input: EnrollRequest,
    canAutoSend = false,
  ): Promise<EnrollResult> {
    const request = EnrollRequestSchema.parse(input);
    const sequence = await this.repository.get(actor.organizationId, sequenceId);
    if (!sequence) throw new NotFoundError('Sequence', sequenceId);
    if (sequence.status !== 'active')
      throw new ValidationError('Activate the sequence before enrolling businesses.', [], {
        details: { reason: 'SEQUENCE_NOT_ACTIVE' },
      });
    const version = await this.repository.version(sequence.id, sequence.headVersion);
    if (!version) throw new NotFoundError('SequenceVersion', `${sequence.id}@${sequence.headVersion}`);
    const timeZone = await this.workspace.timeZone(actor.organizationId);
    const result: EnrollResult = { enrolled: [], skipped: [] };
    const autoSend = canAutoSend && version.settings.approval === 'auto_when_permitted';
    if (request.fromMessageId) {
      const message = await this.messages.get(actor.organizationId, request.fromMessageId);
      if (!message) throw new NotFoundError('OutboundMessage', request.fromMessageId);
      // The first email was this message: the sequence continues after its first email step.
      const firstEmail = version.steps.findIndex((step) => step.kind === 'email');
      const start = firstEmail + 1;
      if (start >= version.steps.length)
        throw new ValidationError('This sequence has no step after its first email.', [], {
          details: { reason: 'NOTHING_TO_FOLLOW' },
        });
      await this.one(actor, version, timeZone, result, {
        autoSend,
        businessId: message.businessId,
        contactId: message.contactId,
        mailboxId: message.mailboxId,
        threadId: message.threadId,
        startIndex: start,
        from: message.sentAt ?? message.scheduledAt,
      });
      return result;
    }
    for (const item of request.items ?? [])
      await this.one(actor, version, timeZone, result, {
        autoSend,
        businessId: item.businessId,
        contactId: item.contactId,
        mailboxId: null,
        threadId: null,
        startIndex: 0,
        from: this.clock.now(),
      });
    return result;
  }

  private async one(
    actor: DraftActor,
    version: SequenceVersionRecord,
    timeZone: string,
    result: EnrollResult,
    item: {
      readonly autoSend: boolean;
      readonly businessId: string;
      readonly contactId: string | null;
      readonly mailboxId: string | null;
      readonly threadId: string | null;
      readonly startIndex: number;
      readonly from: Date;
    },
  ) {
    const preview = await this.compliance.evaluate(
      {
        organizationId: actor.organizationId,
        businessId: item.businessId,
        ...(item.contactId ? { contactId: item.contactId } : {}),
      },
      'email',
      { purpose: 'follow_up', stage: 'preview' },
    );
    if (preview.decision === 'blocked') {
      result.skipped.push({
        businessId: item.businessId as never,
        reason: preview.reasons[0]?.code ?? 'blocked',
      });
      return;
    }
    const step = version.steps[item.startIndex];
    const now = this.clock.now();
    const id = newId();
    const enrolled = await this.repository.enroll({
      id,
      organizationId: actor.organizationId,
      sequenceVersionId: version.id,
      businessId: item.businessId,
      contactId: item.contactId,
      mailboxId: item.mailboxId,
      threadId: item.threadId,
      status: 'active',
      currentStepIndex: item.startIndex,
      nextRunAt: step
        ? nextRunAt({
            from: item.from.getTime() > now.getTime() ? item.from : now,
            businessDays: step.wait.businessDays,
            preferredLocalTime: step.wait.preferredLocalTime,
            timeZone,
            calendars: version.settings.calendars,
          })
        : now,
      variantAssignments: {},
      autoSend: item.autoSend,
      enrolledBy: actor.userId,
    });
    if (!enrolled) {
      result.skipped.push({ businessId: item.businessId as never, reason: 'already_enrolled' });
      return;
    }
    await this.repository.addEvent({
      enrollmentId: id,
      kind: 'enrolled',
      stepId: null,
      variantId: null,
      detail: item.startIndex > 0 ? 'after the first email' : null,
      messageId: null,
    });
    result.enrolled.push(await this.view(enrolled));
  }

  async pause(actor: DraftActor, id: string, reason = 'by a person'): Promise<Enrollment> {
    const enrollment = await this.load(actor, id);
    assertEnrollmentTransition(enrollment.status, 'paused');
    const moved = await this.repository.transition(id, ['active'], 'paused', {
      pauseReason: reason,
      leaseUntil: null,
    });
    if (!moved) throw new ConflictError('The enrollment changed meanwhile.');
    await this.repository.addEvent({
      enrollmentId: id,
      kind: 'paused',
      stepId: null,
      variantId: null,
      detail: reason,
      messageId: null,
    });
    return this.view(moved);
  }

  async resume(actor: DraftActor, id: string): Promise<Enrollment> {
    const enrollment = await this.load(actor, id);
    assertEnrollmentTransition(enrollment.status, 'active');
    const now = this.clock.now();
    const due =
      enrollment.nextRunAt && enrollment.nextRunAt.getTime() > now.getTime() ? enrollment.nextRunAt : now;
    const moved = await this.repository.transition(id, ['paused'], 'active', {
      pauseReason: null,
      nextRunAt: due,
    });
    if (!moved) throw new ConflictError('The enrollment changed meanwhile.');
    await this.repository.addEvent({
      enrollmentId: id,
      kind: 'resumed',
      stepId: null,
      variantId: null,
      detail: null,
      messageId: null,
    });
    return this.view(moved);
  }

  async stop(actor: DraftActor, id: string): Promise<Enrollment> {
    await this.load(actor, id);
    const stopped = await this.stopWith(id, 'manual', 'by a person');
    if (!stopped) throw new ConflictError('The enrollment already ended.');
    return this.view(stopped);
  }

  /** Stops a running enrollment with a reason (subscribers, the executor, a person); undefined when it already ended. */
  async stopWith(
    id: string,
    reason: StopReason,
    detail: string | null,
  ): Promise<EnrollmentRecord | undefined> {
    const now = this.clock.now();
    const stopped = await this.repository.transition(id, RUNNING, 'stopped', {
      stopReason: reason,
      stoppedAt: now,
      nextRunAt: null,
      leaseUntil: null,
    });
    if (!stopped) return undefined;
    await this.repository.addEvent({
      enrollmentId: id,
      kind: 'stopped',
      stepId: null,
      variantId: null,
      detail: detail ?? reason,
      messageId: null,
    });
    await this.events.record(EnrollmentStopped, {
      orgId: stopped.organizationId,
      payload: { enrollmentId: id, businessId: stopped.businessId as never, reason },
    });
    return stopped;
  }

  async list(
    actor: DraftActor,
    filter: { businessId?: string | undefined; sequenceId?: string | undefined },
  ) {
    const rows = await this.repository.enrollments(actor.organizationId, filter);
    return Promise.all(rows.map((row) => this.view(row)));
  }

  private async load(actor: DraftActor, id: string) {
    const enrollment = await this.repository.enrollment(actor.organizationId, id);
    if (!enrollment) throw new NotFoundError('Enrollment', id);
    return enrollment;
  }

  async view(row: EnrollmentRecord): Promise<Enrollment> {
    const version = await this.repository.versionById(row.sequenceVersionId);
    const events = await this.repository.events([row.id]);
    return {
      id: row.id,
      sequenceId: version?.sequenceId ?? row.sequenceVersionId,
      sequenceName: version?.sequence.name ?? '',
      version: version?.version ?? 0,
      businessId: row.businessId as never,
      contactId: row.contactId,
      mailboxId: row.mailboxId,
      status: row.status,
      currentStepIndex: row.currentStepIndex,
      stepCount: version?.steps.length ?? 0,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      variantAssignments: row.variantAssignments,
      stopReason: row.stopReason,
      pauseReason: row.pauseReason,
      stoppedAt: row.stoppedAt?.toISOString() ?? null,
      events: events.map((event) => ({
        at: event.at.toISOString(),
        kind: event.kind,
        stepId: event.stepId,
        detail: event.detail,
        messageId: event.messageId,
      })),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
