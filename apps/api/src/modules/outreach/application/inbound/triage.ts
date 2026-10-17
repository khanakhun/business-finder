import { type AiGateway, OutreachReplyTriage, type ReplyTriageOutput } from '@bf/ai';
import { type Clock, OutreachReplyTriaged, type Triage, type TriageClass } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { AI_GATEWAY } from '../../../platform/ai/ai.module.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { Transactional } from '../../../platform/db/transactional.ts';
import { EventRecorder } from '../../../platform/events/event-recorder.ts';
import { CONFIDENT } from '../../domain/inbound/action-policy.ts';
import { stripQuotes } from '../../domain/inbound/quote-stripper.ts';
import { inboundMetrics } from './inbound-metrics.ts';
import { INBOUND_REPOSITORY, type InboundRecord, type InboundRepository } from './ports.ts';

// Reply triage (BF-054): the model reads the new part of a human reply (wrapped as untrusted data) and our message
// it answers, and returns a class, a confidence, entities and a one-line summary. Low confidence or a suspected
// injection → a person must look (`needs_human`); a failed call too — the deterministic paths (unsubscribe detector,
// stop on receipt) already ran at ingestion. The result is an event; the action policy is its subscriber. A person can
// correct the class: the correction is kept as feedback and the safe actions run again.

@Injectable()
export class ReplyTriageService {
  constructor(
    @Inject(INBOUND_REPOSITORY) private readonly inbound: InboundRepository,
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventRecorder,
  ) {}

  async triage(inboundId: string, logger: Logger): Promise<'done' | 'needs_human' | 'skipped'> {
    const row = await this.inbound.byId(inboundId);
    if (!row || row.kind !== 'human' || row.triageStatus !== 'pending') return 'skipped';
    const context = await this.inbound.triageContext(row.id);
    if (!context) return 'skipped';
    let triage: Triage | null = null;
    try {
      const result = await this.ai.run(
        OutreachReplyTriage,
        {
          uiLocale: context.locale,
          businessName: context.businessName,
          ourMessage: context.ourMessage,
          reply: { subject: row.subject, text: stripQuotes(row.bodyText) || row.bodyText.slice(0, 8_000) },
          receivedOn: row.receivedAt.toISOString().slice(0, 10),
        },
        { orgId: row.organizationId },
      );
      const output = result.output as ReplyTriageOutput;
      triage = { ...output, model: result.model, promptVersion: String(result.promptVersion) };
    } catch (error) {
      // No model answer: a person decides. The unsubscribe detector and the stop on receipt already ran.
      logger.warn({ err: error, inboundId }, 'reply triage failed');
    }
    const needsHuman = !triage || triage.confidence < CONFIDENT || triage.injectionSuspected;
    await this.record(row, triage, needsHuman ? 'needs_human' : 'done', null);
    inboundMetrics.triage().inc({ class: triage?.class ?? 'none', needs_human: String(needsHuman) });
    inboundMetrics
      .triageLatency()
      .observe(Math.max(0, (this.clock.now().getTime() - row.receivedAt.getTime()) / 1000));
    return needsHuman ? 'needs_human' : 'done';
  }

  /** A person's correction: kept as feedback (eval set), and the policy runs again with the corrected class. */
  async correct(row: InboundRecord, correctedClass: TriageClass, userId: string | null) {
    const now = this.clock.now();
    const updated = await this.inbound.update(row.id, {
      correctedClass,
      correctedBy: userId,
      correctedAt: now,
      triageStatus: 'corrected',
    });
    if (!updated) return row;
    await this.record(updated, updated.triage, 'corrected', correctedClass);
    return updated;
  }

  @Transactional()
  private async record(
    row: InboundRecord,
    triage: Triage | null,
    status: 'done' | 'needs_human' | 'corrected',
    corrected: TriageClass | null,
  ) {
    const context = await this.inbound.triageContext(row.id);
    if (status !== 'corrected') await this.inbound.update(row.id, { triage, triageStatus: status });
    const effectiveClass = corrected ?? triage?.class ?? null;
    await this.inbound.setThreadClass(row.threadId, effectiveClass);
    if (!effectiveClass || !context) return;
    await this.events.record(OutreachReplyTriaged, {
      orgId: row.organizationId,
      ...(corrected ? {} : { actor: { type: 'job' as const, id: 'outreach.triage' } }),
      payload: {
        inboundId: row.id,
        threadId: row.threadId,
        businessId: context.businessId as never,
        contactId: context.contactId,
        outboundMessageId: row.outboundMessageId,
        class: effectiveClass,
        confidence: corrected ? 1 : (triage?.confidence ?? 0),
        needsHuman: status === 'needs_human',
        unsubscribeDetected: row.unsubscribeDetected,
        corrected: corrected !== null,
      },
    });
  }
}
