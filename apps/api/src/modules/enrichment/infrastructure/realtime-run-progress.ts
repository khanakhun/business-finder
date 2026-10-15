import { ENRICHMENT_RUN_PROGRESSED } from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { RealtimePublisher } from '../../realtime/index.ts';
import { toRunView } from '../application/enrichment.use-cases.ts';
import type { RunProgress, RunRecord, StepRecord } from '../application/ports.ts';

/**
 * `enrichment.run.progressed` to the workspace that asked, at each claim and completion and at the end — a handful
 * per run, so no throttling (intermediate states are never dropped). The payload is the run as
 * `GET /v1/enrichment/runs/:id` returns it.
 */
@Injectable()
export class RealtimeEnrichmentProgress implements RunProgress {
  constructor(private readonly realtime: RealtimePublisher) {}

  async publish(run: RunRecord, steps: readonly StepRecord[]): Promise<void> {
    await this.realtime.publish(run.organizationId, {
      type: ENRICHMENT_RUN_PROGRESSED,
      entity: 'business',
      entityId: run.businessId,
      payload: toRunView(run, steps),
    });
  }
}
