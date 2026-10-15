import { DISCOVERY_RUN_FINISHED, DISCOVERY_RUN_PROGRESSED } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import { RealtimePublisher } from '../../realtime/index.ts';
import {
  DISCOVERY_RUN_REPOSITORY,
  type DiscoveryRunRepository,
  type RunProgress,
  type RunRecord,
} from '../application/run-ports.ts';

const THROTTLE_MS = 1_000;

const payloadOf = (run: RunRecord) => ({
  status: run.status,
  reason: run.reason,
  counts: run.counts,
  costUsd: run.costUsd,
  budgetUsd: run.budgetUsd,
});

/** Realtime progress: ≤ 1 event per run per second across workers (Valkey NX key), always one at the end. */
@Injectable()
export class RealtimeRunProgress implements RunProgress {
  constructor(
    private readonly realtime: RealtimePublisher,
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(DISCOVERY_RUN_REPOSITORY) private readonly runs: DiscoveryRunRepository,
  ) {}

  async progressed(runId: string): Promise<void> {
    const due = await this.valkey.set(`bf:discovery:progress:${runId}`, '1', 'PX', THROTTLE_MS, 'NX');
    if (due !== 'OK') return;
    const run = await this.runs.getRun(runId);
    if (run?.status !== 'running') return;
    await this.realtime.publish(run.organizationId, {
      type: DISCOVERY_RUN_PROGRESSED,
      entity: 'discovery_run',
      entityId: run.id,
      payload: payloadOf(run),
    });
  }

  async finished(run: RunRecord): Promise<void> {
    await this.realtime.publish(run.organizationId, {
      type: DISCOVERY_RUN_FINISHED,
      entity: 'discovery_run',
      entityId: run.id,
      payload: payloadOf(run),
    });
  }
}
