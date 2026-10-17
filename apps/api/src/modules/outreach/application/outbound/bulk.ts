import {
  type ApproveBulkRequest,
  ApproveBulkRequestSchema,
  type BulkActionResult,
  type BulkRun,
  type BulkRunDetail,
  ConflictError,
  DomainError,
  EditPendingMessageRequestSchema,
  NotFoundError,
  newId,
  type OutboundStatus,
  type StartBulkRequest,
  StartBulkRequestSchema,
  ValidationError,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { ComplianceService } from '../../../compliance/index.ts';
import { FeatureFlagService } from '../../../workspace/index.ts';
import { maskAddress } from '../../domain/outbound/outbound-message.ts';
import { type DraftActor, DraftsService } from '../drafting/drafts.service.ts';
import { OutboundCommands } from './outbound.commands.ts';
import {
  BULK_QUEUE,
  BULK_REPOSITORY,
  type BulkQueue,
  type BulkRepository,
  type BulkRunRecord,
  OUTBOUND_REPOSITORY,
  type OutboundRepository,
} from './ports.ts';

// Bulk outreach (BF-052): drafts for up to 100 businesses at once, never sent without a person's approval unless
// every auto-send condition holds (the starter holds `outreach:auto_send`, the workspace's `autoSend` flag is on,
// and the compliance policy of each item was reviewed with automatic sending enabled). Each business is judged
// first — refused ones are listed with their reasons and alternatives, and no draft is written for them — then
// drafted (AI or template) into a message waiting for approval. Approving judges each item again.

const evaluate = (
  compliance: ComplianceService,
  organizationId: string,
  businessId: string,
  purpose: string,
  contactId?: string | null,
) =>
  compliance.evaluate({ organizationId, businessId, ...(contactId ? { contactId } : {}) }, 'email', {
    purpose,
    stage: 'enqueue',
  });

const allowed = (decision: string) => decision === 'allowed' || decision === 'allowed_with_conditions';

@Injectable()
export class BulkOutreach {
  constructor(
    @Inject(BULK_REPOSITORY) private readonly runs: BulkRepository,
    @Inject(OUTBOUND_REPOSITORY) private readonly messages: OutboundRepository,
    @Inject(BULK_QUEUE) private readonly queue: BulkQueue,
    private readonly drafts: DraftsService,
    private readonly commands: OutboundCommands,
    private readonly compliance: ComplianceService,
    private readonly flags: FeatureFlagService,
  ) {}

  async start(actor: DraftActor, input: StartBulkRequest, canAutoSend: boolean): Promise<BulkRun> {
    const request = StartBulkRequestSchema.parse(input);
    const businessIds = [...new Set(request.businessIds)];
    const autoApprove = canAutoSend && (await this.flags.isEnabled(actor.organizationId, 'autoSend'));
    const run = await this.runs.insertRun({
      id: newId(),
      organizationId: actor.organizationId,
      createdBy: actor.userId,
      offer: request.offer,
      purpose: request.purpose,
      mode: request.mode,
      templateId: request.templateId ?? null,
      locale: actor.locale,
      autoApprove,
      businessIds,
    });
    for (const businessId of businessIds) await this.queue.draft(actor.organizationId, run.id, businessId);
    return (await this.views([run]))[0] as BulkRun;
  }

  /** One business of a run (the bulk job): judged, drafted, waiting for approval (or approved automatically). */
  async draftOne(runId: string, businessId: string, logger: Logger): Promise<'drafted' | 'skipped' | 'done'> {
    const run = await this.runs.run(null, runId);
    if (!run || run.status === 'cancelled') return 'done';
    const actor: DraftActor = {
      organizationId: run.organizationId,
      userId: run.createdBy,
      locale: run.locale,
    };
    const key = `bulk:${run.id}:${businessId}`;
    if (await this.messages.byIdempotencyKey(run.organizationId, key)) return 'done';
    if (run.skipped.some((skip) => skip.businessId === businessId)) return 'done';
    const decision = await evaluate(this.compliance, run.organizationId, businessId, run.offer);
    if (!allowed(decision.decision) || !decision.id) {
      await this.runs.settle(run.id, {
        skipped: {
          businessId,
          decision: decision.decision,
          reasons: decision.reasons.map((reason) => reason.code),
          alternatives: decision.alternatives.map((alternative) => alternative.code),
        },
      });
      return 'skipped';
    }
    try {
      const created = await this.drafts.create(actor, {
        businessId,
        offer: run.offer,
        purpose: run.purpose,
        mode: run.mode,
        ...(run.templateId ? { templateId: run.templateId } : {}),
      });
      const draft = await this.drafts.draft(actor, created.id);
      const { message } = await this.commands.enqueue(actor, draft, {
        decisionId: decision.id as never,
        decision,
        subject: draft.subject,
        mailboxId: undefined,
        requestedAt: null,
        idempotencyKey: key,
        pending: { bulkRunId: run.id },
      });
      await this.runs.settle(run.id, { drafted: true });
      const clean = !draft.lint.some((issue) => issue.severity === 'error');
      if (run.autoApprove && decision.autoSendPermitted && clean) {
        const again = await evaluate(
          this.compliance,
          run.organizationId,
          businessId,
          run.offer,
          message.contactId,
        );
        await this.commands.approve(actor, message, again, null);
      }
      return 'drafted';
    } catch (error) {
      // A business without an address, a draft the model could not write: listed, never retried blindly.
      if (!(error instanceof DomainError)) throw error;
      logger.warn({ err: error, runId, businessId }, 'bulk item skipped');
      await this.runs.settle(run.id, {
        skipped: {
          businessId,
          decision: 'error',
          reasons: [],
          alternatives: [],
          error: error.message.slice(0, 200),
        },
      });
      return 'skipped';
    }
  }

  async approve(actor: DraftActor, runId: string, input: ApproveBulkRequest): Promise<BulkActionResult> {
    const request = ApproveBulkRequestSchema.parse(input);
    const run = await this.load(actor, runId);
    const pending = (await this.runs.messages(actor.organizationId, run.id)).filter(
      (message) => message.status === 'pending_approval',
    );
    const chosen = request.messageIds
      ? pending.filter((message) => request.messageIds?.includes(message.id))
      : pending;
    if (request.expectedCount !== undefined && request.expectedCount !== chosen.length)
      throw new ConflictError('The approval queue changed: review it again.', {
        details: { reason: 'QUEUE_CHANGED' },
      });
    const result: BulkActionResult = { approved: 0, rejected: 0, refused: 0, failed: [] };
    for (const message of chosen) {
      try {
        const decision = await evaluate(
          this.compliance,
          actor.organizationId,
          message.businessId,
          message.offer,
          message.contactId,
        );
        const moved = await this.commands.approve(actor, message, decision, actor.userId);
        if (moved?.status === 'queued') result.approved++;
        else if (moved?.status === 'cancelled') result.refused++;
        else result.failed.push({ messageId: message.id, reason: 'CHANGED' });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        const reason = error.details?.reason;
        result.failed.push({
          messageId: message.id,
          reason: typeof reason === 'string' ? reason : error.code,
        });
      }
    }
    await this.complete(actor, run);
    return result;
  }

  async reject(actor: DraftActor, runId: string, messageIds: readonly string[]): Promise<BulkActionResult> {
    const run = await this.load(actor, runId);
    const result: BulkActionResult = { approved: 0, rejected: 0, refused: 0, failed: [] };
    for (const id of new Set(messageIds)) {
      const message = await this.messages.get(actor.organizationId, id);
      if (!message || message.bulkRunId !== run.id || message.status !== 'pending_approval') {
        result.failed.push({ messageId: id, reason: 'NOT_PENDING' });
        continue;
      }
      await this.commands.cancel(actor, id);
      result.rejected++;
    }
    await this.complete(actor, run);
    return result;
  }

  /** Inline edit of a waiting message: its draft changes, the preview is rendered again. */
  async edit(actor: DraftActor, messageId: string, input: unknown) {
    const patch = EditPendingMessageRequestSchema.parse(input);
    const message = await this.messages.get(actor.organizationId, messageId);
    if (!message) throw new NotFoundError('OutboundMessage', messageId);
    if (message.status !== 'pending_approval' || !message.draftId)
      throw new ValidationError('Only a message waiting for approval can be edited.', [], {
        details: { reason: 'NOT_PENDING' },
      });
    await this.drafts.update(actor, message.draftId, patch);
    return this.commands.refreshPreview(actor, message);
  }

  async list(actor: DraftActor): Promise<BulkRun[]> {
    return this.views(await this.runs.runs(actor.organizationId, 50));
  }

  async detail(actor: DraftActor, runId: string): Promise<BulkRunDetail> {
    const run = await this.load(actor, runId);
    const [view] = await this.views([run]);
    const rows = await this.runs.messages(actor.organizationId, run.id);
    const decisions = await this.compliance.decisionsById(
      actor.organizationId,
      rows.map((row) => row.enqueueDecisionId).filter((id): id is string => !!id),
    );
    const byId = new Map(decisions.map((decision) => [decision.id, decision]));
    const names = await this.runs.businessNames(run.skipped.map((skip) => skip.businessId));
    return {
      run: view as BulkRun,
      items: rows.map((row) => {
        const decision = row.enqueueDecisionId ? byId.get(row.enqueueDecisionId) : undefined;
        return {
          id: row.id,
          businessId: row.businessId as never,
          businessName: row.businessName,
          contactId: row.contactId,
          recipient: maskAddress(row.toEmail),
          mailboxId: row.mailboxId,
          mailboxEmail: row.mailboxEmail,
          subject: row.subject,
          purpose: row.purpose,
          offer: row.offer,
          locale: row.locale,
          status: row.status,
          scheduledAt: row.scheduledAt.toISOString(),
          sentAt: row.sentAt?.toISOString() ?? null,
          attempts: row.attempts,
          lastError: row.lastError,
          blockedReasons: row.blockedReasons,
          sequence: null,
          bulkRunId: row.bulkRunId,
          createdAt: row.createdAt.toISOString(),
          draftId: row.draftId,
          bodyText: row.bodyText,
          bodyHtml: row.bodyHtml,
          compliance: decision
            ? { decision: decision.decision, reasons: decision.reasons.map((reason) => reason.code) }
            : null,
        };
      }),
      skipped: run.skipped.map((skip) => ({
        ...skip,
        businessId: skip.businessId as never,
        businessName: names.get(skip.businessId) ?? '',
      })),
    };
  }

  private async load(actor: DraftActor, runId: string) {
    const run = await this.runs.run(actor.organizationId, runId);
    if (!run) throw new NotFoundError('BulkRun', runId);
    return run;
  }

  /** A ready run with nothing left to approve is completed. */
  private async complete(actor: DraftActor, run: BulkRunRecord) {
    const current = await this.runs.run(actor.organizationId, run.id);
    if (current?.status !== 'ready') return;
    const counts = (await this.runs.counts([run.id])).get(run.id) ?? {};
    if (!counts.pending_approval) await this.runs.setStatus(run.id, 'completed');
  }

  private async views(runs: readonly BulkRunRecord[]): Promise<BulkRun[]> {
    const counts = await this.runs.counts(runs.map((run) => run.id));
    return runs.map((run) => {
      const byStatus: Partial<Record<OutboundStatus, number>> = counts.get(run.id) ?? {};
      const queuedOrLater = (
        ['queued', 'sending', 'sent', 'failed', 'blocked', 'bounced', 'replied'] as const
      ).reduce((sum, status) => sum + (byStatus[status] ?? 0), 0);
      return {
        id: run.id,
        offer: run.offer,
        purpose: run.purpose,
        mode: run.mode,
        status: run.status,
        autoApprove: run.autoApprove,
        total: run.businessIds.length,
        drafted: run.drafted,
        skipped: run.skipped.length,
        pending: byStatus.pending_approval ?? 0,
        queued: queuedOrLater,
        createdBy: run.createdBy,
        createdAt: run.createdAt.toISOString(),
      };
    });
  }
}
