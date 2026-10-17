import { type Clock, DomainError, type SequenceStep, type StopReason } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { ComplianceService } from '../../../compliance/index.ts';
import { CrmPipeline } from '../../../crm/index.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { NotificationService } from '../../../realtime/index.ts';
import { FeatureFlagService, WorkspaceDefaults } from '../../../workspace/index.ts';
import { ComplianceRefusedError } from '../../domain/outbound/errors.ts';
import { nextRunAt } from '../../domain/sequences/business-calendar.ts';
import { isAlternative } from '../../domain/sequences/sequence-definition.ts';
import { shouldStop } from '../../domain/sequences/stop-policy.ts';
import { assignVariant } from '../../domain/sequences/variant-assigner.ts';
import { type DraftActor, DraftsService } from '../drafting/drafts.service.ts';
import { OutboundCommands } from '../outbound/outbound.commands.ts';
import { EnrollmentsService } from './enrollments.service.ts';
import {
  type EnrollmentRecord,
  SEQUENCE_REPOSITORY,
  type SequenceRepository,
  type SequenceVersionRecord,
} from './ports.ts';

// One due step of an enrollment (BF-053), under the tick's lease:
//   1. the stop policy (a reply, a bounce, compliance, the pipeline, do-not-contact) — stop with the reason;
//   2. the reply-sync guard: a mailbox whose replies are not being read (no successful sync for 15 minutes) pauses
//      the enrollment and tells the owner — never follow up blind;
//   3. the step's condition (preview viewed or not since the last email) — skipped when it does not hold;
//   4. an email step: its variant, a draft (template or AI, grounded, BF-051), then the outbound pipeline (BF-052:
//      compliance again, in the thread, from the same mailbox), queued — or in the approvals queue unless the enroller
//      may auto-send, the workspace allows it and the policy permits it. The enrollment then waits for that message;
//   5. a task step: a CRM task for the owner, then the next step.
// Every executed, skipped, paused or stopped step is in the enrollment's trail.

const SYNC_HEALTHY_MS = 15 * 60_000;

export type StepOutcome = 'stale' | 'stopped' | 'paused' | 'skipped' | 'waiting' | 'task' | 'completed';

const TASK_TYPE = { task_call: 'call', task_whatsapp: 'other', task_custom: 'other' } as const;
const TASK_TITLE = {
  task_call: 'Call {name} (sequence follow-up)',
  task_whatsapp: 'Send a WhatsApp message to {name} (sequence follow-up)',
  task_custom: 'Sequence follow-up for {name}',
} as const;

@Injectable()
export class SequenceExecutor {
  constructor(
    @Inject(SEQUENCE_REPOSITORY) private readonly repository: SequenceRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly enrollments: EnrollmentsService,
    private readonly drafts: DraftsService,
    private readonly commands: OutboundCommands,
    private readonly compliance: ComplianceService,
    private readonly crm: CrmPipeline,
    private readonly flags: FeatureFlagService,
    private readonly workspace: WorkspaceDefaults,
    private readonly notifications: NotificationService,
  ) {}

  async run(enrollmentId: string, leaseIso: string, logger: Logger): Promise<StepOutcome> {
    const lease = new Date(leaseIso);
    const enrollment = await this.repository.enrollmentById(enrollmentId);
    if (!enrollment || enrollment.status !== 'active' || enrollment.leaseUntil?.getTime() !== lease.getTime())
      return 'stale';
    const version = await this.repository.versionById(enrollment.sequenceVersionId);
    if (!version) return 'stale';
    const step = version.steps[enrollment.currentStepIndex];
    if (!step) return this.complete(enrollment);

    // 1. Stop policy.
    const reason = await this.stopReason(enrollment, version);
    if (reason) {
      await this.enrollments.stopWith(enrollment.id, reason, null);
      return 'stopped';
    }
    // 2. Reply-sync guard (only once a mailbox is known: the first email may pick one).
    if (step.kind === 'email' && enrollment.mailboxId) {
      const synced = await this.repository.lastSyncSuccess(enrollment.mailboxId);
      if (!synced || this.clock.now().getTime() - synced.getTime() > SYNC_HEALTHY_MS)
        return this.pause(enrollment, 'reply_sync_unhealthy', 'Replies of this mailbox are not being read.');
    }
    // 3. Condition.
    if (step.condition !== 'always') {
      const lastEmail = (await this.repository.events([enrollment.id]))
        .filter((event) => event.kind === 'executed' && event.messageId)
        .at(-1);
      const viewed = lastEmail
        ? await this.repository.previewViewedSince(enrollment.id, lastEmail.at)
        : false;
      if ((step.condition === 'previewViewed') !== viewed)
        return this.advance(
          enrollment,
          version,
          lease,
          'skipped',
          step,
          `condition ${step.condition} not met`,
        );
    }
    return step.kind === 'email'
      ? this.email(enrollment, version, step, lease, logger)
      : this.task(enrollment, version, step, lease);
  }

  private async email(
    enrollment: EnrollmentRecord,
    version: SequenceVersionRecord & { readonly sequence: { readonly offer: string } },
    step: SequenceStep,
    lease: Date,
    logger: Logger,
  ): Promise<StepOutcome> {
    const actor: DraftActor = {
      organizationId: enrollment.organizationId,
      userId: enrollment.enrolledBy,
      locale: 'en',
    };
    const variantId =
      assignVariant(enrollment.id, step.id, step.variants) ?? step.variants[0]?.id ?? 'default';
    const variant = step.variants.find((candidate) => candidate.id === variantId);
    try {
      const created = await this.drafts.create(actor, {
        businessId: enrollment.businessId as never,
        contactId: enrollment.contactId,
        offer: version.sequence.offer as never,
        // In the thread once there is one (a reply-mode follow-up); otherwise a first email opens it.
        purpose: enrollment.threadId && step.threading === 'reply_in_thread' ? 'follow_up' : 'first_touch',
        mode: variant?.templateId ? 'template' : 'ai',
        ...(variant?.templateId ? { templateId: variant.templateId } : {}),
        ...(variant?.instructions ? { instructions: variant.instructions } : {}),
        ...(enrollment.mailboxId ? { mailboxId: enrollment.mailboxId } : {}),
      });
      const draft = await this.drafts.draft(actor, created.id);
      if (step.skipIfUnverified && !(await this.drafts.recipient(draft)))
        return this.advance(enrollment, version, lease, 'skipped', step, 'no verified email');
      const decision = await this.compliance.evaluate(
        {
          organizationId: enrollment.organizationId,
          businessId: enrollment.businessId,
          ...(enrollment.contactId ? { contactId: enrollment.contactId } : {}),
        },
        'email',
        { purpose: version.sequence.offer, stage: 'enqueue' },
      );
      if (decision.decision === 'manual_only') {
        // The email cannot go automatically here: the owner gets a task to contact them by hand.
        await this.crm.followUp(enrollment.organizationId, enrollment.businessId, {
          title: 'Contact this business by hand (the sequence’s email is manual-only here)',
          type: 'email',
          dueAt: this.clock.now(),
          assigneeId: await this.crm.ownerOf(enrollment.organizationId, enrollment.businessId),
        });
        return this.advance(enrollment, version, lease, 'skipped', step, 'manual only: task created');
      }
      if (decision.decision === 'blocked' || !decision.id) {
        await this.enrollments.stopWith(
          enrollment.id,
          'compliance_blocked',
          decision.reasons[0]?.code ?? null,
        );
        return 'stopped';
      }
      const auto =
        enrollment.autoSend &&
        version.settings.approval === 'auto_when_permitted' &&
        decision.autoSendPermitted &&
        (await this.flags.isEnabled(enrollment.organizationId, 'autoSend'));
      const { message } = await this.commands.enqueue(actor, draft, {
        decisionId: decision.id as never,
        decision,
        subject: draft.subject,
        mailboxId: enrollment.mailboxId ?? undefined,
        requestedAt: null,
        idempotencyKey: `seq:${enrollment.id}:${step.id}`,
        ...(auto ? {} : { pending: { bulkRunId: null } }),
        sequence: { enrollmentId: enrollment.id, stepIndex: enrollment.currentStepIndex },
      });
      const updated = await this.repository.updateLeased(enrollment.id, lease, {
        waitingMessageId: message.id,
        nextRunAt: null,
        leaseUntil: null,
        mailboxId: enrollment.mailboxId ?? message.mailboxId,
        threadId: enrollment.threadId ?? message.threadId,
        variantAssignments: { ...enrollment.variantAssignments, [step.id]: variantId },
      });
      if (!updated) return 'stale';
      await this.repository.addEvent({
        enrollmentId: enrollment.id,
        kind: 'executed',
        stepId: step.id,
        variantId,
        detail: auto ? 'queued' : 'waiting for approval',
        messageId: message.id,
      });
      return 'waiting';
    } catch (error) {
      if (error instanceof ComplianceRefusedError) {
        await this.enrollments.stopWith(enrollment.id, 'compliance_blocked', error.message);
        return 'stopped';
      }
      if (!(error instanceof DomainError)) throw error;
      // No address, no mailbox, a draft the model could not write: a person looks.
      logger.warn({ err: error, enrollmentId: enrollment.id }, 'sequence step could not run');
      return this.pause(enrollment, 'step_failed', error.message.slice(0, 200));
    }
  }

  private async task(
    enrollment: EnrollmentRecord,
    version: SequenceVersionRecord,
    step: SequenceStep,
    lease: Date,
  ): Promise<StepOutcome> {
    const kind = step.kind as keyof typeof TASK_TYPE;
    await this.crm.followUp(enrollment.organizationId, enrollment.businessId, {
      title: (step.taskTitle ?? TASK_TITLE[kind].replace('{name}', 'this business')).slice(0, 200),
      type: TASK_TYPE[kind],
      dueAt: this.clock.now(),
      assigneeId: await this.crm.ownerOf(enrollment.organizationId, enrollment.businessId),
    });
    const outcome = await this.advance(enrollment, version, lease, 'executed', step, 'task created');
    return outcome === 'completed' ? 'completed' : 'task';
  }

  /** The step is done (or skipped): the next one is scheduled, or the enrollment completes. */
  async advance(
    enrollment: EnrollmentRecord,
    version: SequenceVersionRecord,
    lease: Date | null,
    kind: 'executed' | 'skipped',
    step: SequenceStep,
    detail: string | null,
  ): Promise<StepOutcome> {
    let nextIndex = enrollment.currentStepIndex + 1;
    await this.repository.addEvent({
      enrollmentId: enrollment.id,
      kind,
      stepId: step.id,
      variantId: enrollment.variantAssignments[step.id] ?? null,
      detail,
      messageId: null,
    });
    // The other branch of a step that ran (preview viewed / not viewed) is never sent too.
    const alternative = version.steps[nextIndex];
    if (kind === 'executed' && alternative && isAlternative(version.steps, nextIndex)) {
      await this.repository.addEvent({
        enrollmentId: enrollment.id,
        kind: 'skipped',
        stepId: alternative.id,
        variantId: null,
        detail: 'the other branch was sent',
        messageId: null,
      });
      nextIndex++;
    }
    const next = version.steps[nextIndex];
    if (!next) return this.complete(enrollment);
    const patch = {
      currentStepIndex: nextIndex,
      waitingMessageId: null,
      leaseUntil: null,
      nextRunAt: nextRunAt({
        from: this.clock.now(),
        businessDays: next.wait.businessDays,
        preferredLocalTime: next.wait.preferredLocalTime,
        timeZone: await this.workspace.timeZone(enrollment.organizationId),
        calendars: version.settings.calendars,
      }),
    };
    const updated = lease
      ? await this.repository.updateLeased(enrollment.id, lease, patch)
      : await this.repository.updateEnrollment(enrollment.id, patch);
    return updated ? 'skipped' : 'stale';
  }

  private async complete(enrollment: EnrollmentRecord): Promise<StepOutcome> {
    const done = await this.repository.transition(enrollment.id, ['active'], 'completed', {
      nextRunAt: null,
      leaseUntil: null,
      waitingMessageId: null,
    });
    if (done)
      await this.repository.addEvent({
        enrollmentId: enrollment.id,
        kind: 'completed',
        stepId: null,
        variantId: null,
        detail: null,
        messageId: null,
      });
    return 'completed';
  }

  async pause(enrollment: EnrollmentRecord, code: string, detail: string): Promise<StepOutcome> {
    const paused = await this.repository.transition(enrollment.id, ['active'], 'paused', {
      pauseReason: code,
      leaseUntil: null,
    });
    if (!paused) return 'stale';
    await this.repository.addEvent({
      enrollmentId: enrollment.id,
      kind: 'paused',
      stepId: null,
      variantId: null,
      detail,
      messageId: null,
    });
    const owner = await this.crm.ownerOf(enrollment.organizationId, enrollment.businessId);
    const business = (await this.repository.businessName(enrollment.businessId)) ?? '';
    await this.notifications.notify({
      organizationId: enrollment.organizationId,
      recipients: owner ? [owner] : enrollment.enrolledBy ? [enrollment.enrolledBy] : 'members',
      type: 'sequence_paused',
      params: { business: business.slice(0, 200), reason: detail.slice(0, 200) },
      entity: { type: 'business', id: enrollment.businessId },
      link: `/businesses/${enrollment.businessId}`,
    });
    return 'paused';
  }

  /** The stop policy's facts for this enrollment now. */
  private async stopReason(
    enrollment: EnrollmentRecord,
    version: SequenceVersionRecord,
  ): Promise<StopReason | null> {
    const [replied, state, decision] = await Promise.all([
      this.repository.hasHumanReplySince(
        enrollment.organizationId,
        enrollment.businessId,
        enrollment.createdAt,
      ),
      this.crm.stateOf(enrollment.organizationId, enrollment.businessId),
      this.compliance.evaluate(
        {
          organizationId: enrollment.organizationId,
          businessId: enrollment.businessId,
          ...(enrollment.contactId ? { contactId: enrollment.contactId } : {}),
        },
        'email',
        { purpose: 'follow_up', stage: 'preview' },
      ),
    ]);
    const codes = decision.reasons.map((reason) => reason.code);
    return shouldStop({
      humanReply: replied,
      hardBounce: false,
      unsubscribed: codes.some((code) => code.includes('unsubscrib')),
      suppressed: decision.decision === 'blocked' && codes.some((code) => code.includes('suppress')),
      doNotContact: state?.doNotContact ?? false,
      leadCaptured: false,
      pipelineStatus: state?.status ?? null,
      contactInvalid: false,
      mailboxRemoved: false,
      complianceBlocked: decision.decision === 'blocked',
      stopOnLead: version.settings.stopOnPreviewLead,
    });
  }
}
