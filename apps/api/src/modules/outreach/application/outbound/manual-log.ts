import {
  type ManualContactChannel,
  type ManualContactLog,
  ManualContactLogged,
  type ManualLogRequest,
  ManualLogRequestSchema,
  newId,
  type OutreachChannel,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ComplianceService } from '../../../compliance/index.ts';
import { CrmPipeline } from '../../../crm/index.ts';
import { Transactional } from '../../../platform/db/transactional.ts';
import { EventRecorder } from '../../../platform/events/event-recorder.ts';
import { ComplianceRefusedError } from '../../domain/outbound/errors.ts';
import type { DraftActor } from '../drafting/drafts.service.ts';
import { type ManualLogRecord, OUTBOUND_REPOSITORY, type OutboundRepository } from './ports.ts';

// Contacts made by hand (BF-052, also BF-057): "Copy & send manually", a call, a WhatsApp message, a letter, a
// visit. The compliance gate is evaluated at the `manual_log` stage and persisted; a suppressed or do-not-contact
// business is refused (blocked), anything else is logged with its decision. The pipeline moves as for a send.

// DECISION(BF-052): the gate has no in-person channel; a visit is judged as a phone call (direct, personal contact).
const GATE_CHANNEL: Record<ManualContactChannel, OutreachChannel> = {
  email: 'email',
  phone: 'phone',
  whatsapp: 'whatsapp',
  letter: 'letter',
  in_person: 'phone',
};

const view = (row: ManualLogRecord, decision: string): ManualContactLog => ({
  id: row.id,
  businessId: row.businessId as never,
  contactId: row.contactId,
  channel: row.channel,
  decisionId: row.decisionId,
  decision,
  summary: row.summary,
  outcome: row.outcome,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

@Injectable()
export class ManualContactLogs {
  constructor(
    @Inject(OUTBOUND_REPOSITORY) private readonly repository: OutboundRepository,
    private readonly compliance: ComplianceService,
    private readonly crm: CrmPipeline,
    private readonly events: EventRecorder,
  ) {}

  async log(actor: DraftActor, input: ManualLogRequest): Promise<ManualContactLog> {
    const request = ManualLogRequestSchema.parse(input);
    const decision = await this.compliance.evaluate(
      {
        organizationId: actor.organizationId,
        businessId: request.businessId,
        ...(request.contactId ? { contactId: request.contactId } : {}),
      },
      GATE_CHANNEL[request.channel],
      { purpose: request.purpose, stage: 'manual_log' },
    );
    if (decision.decision === 'blocked' || !decision.id) throw new ComplianceRefusedError(decision);
    const row = await this.store(actor, request, decision.id);
    return view(row, decision.decision);
  }

  @Transactional()
  private async store(
    actor: DraftActor,
    request: ReturnType<typeof ManualLogRequestSchema.parse>,
    decisionId: string,
  ) {
    const row = await this.repository.insertManualLog({
      id: newId(),
      organizationId: actor.organizationId,
      businessId: request.businessId,
      contactId: request.contactId,
      channel: request.channel,
      decisionId,
      summary: request.summary,
      outcome: request.outcome ?? null,
      createdBy: actor.userId,
    });
    await this.crm.markContacted(actor.organizationId, request.businessId);
    await this.events.record(ManualContactLogged, {
      orgId: actor.organizationId,
      payload: {
        logId: row.id,
        businessId: request.businessId,
        contactId: request.contactId,
        channel: request.channel,
      },
    });
    return row;
  }

  async forBusiness(actor: DraftActor, businessId: string): Promise<ManualContactLog[]> {
    const rows = await this.repository.manualLogs(actor.organizationId, businessId, 50);
    const decisions = await this.compliance.decisionsById(
      actor.organizationId,
      rows.map((row) => row.decisionId),
    );
    const byId = new Map(decisions.map((decision) => [decision.id, decision.decision]));
    return rows.map((row) => view(row, byId.get(row.decisionId) ?? 'unknown'));
  }
}
