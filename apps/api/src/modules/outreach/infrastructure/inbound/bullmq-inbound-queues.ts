import { type OrgId, OutreachSyncJob, OutreachTriageJob } from '@bf/contracts';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { InboundQueues } from '../../application/inbound/ports.ts';

@Injectable()
export class BullmqInboundQueues implements InboundQueues {
  private readonly syncs: TypedProducer<typeof OutreachSyncJob>;
  private readonly triages: TypedProducer<typeof OutreachTriageJob>;

  constructor(
    @InjectQueue(QUEUES.outreachSync.name) sync: Queue,
    @InjectQueue(QUEUES.outreachTriage.name) triage: Queue,
  ) {
    this.syncs = new TypedProducer(sync, OutreachSyncJob);
    this.triages = new TypedProducer(triage, OutreachTriageJob);
  }

  async sync(organizationId: string, mailboxId: string, key: string): Promise<void> {
    await this.syncs.add({ orgId: organizationId as OrgId, idempotencyKey: key, mailboxId });
  }

  async triage(organizationId: string, inboundId: string): Promise<void> {
    await this.triages.add({
      orgId: organizationId as OrgId,
      idempotencyKey: `triage:${inboundId}`,
      inboundId,
    });
  }
}

/** OpenAPI generation boots without Valkey. */
export const OPENAPI_INBOUND_QUEUES: InboundQueues = { sync: async () => {}, triage: async () => {} };
