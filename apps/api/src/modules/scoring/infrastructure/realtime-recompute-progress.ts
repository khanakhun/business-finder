import { SCORING_RECOMPUTE_PROGRESSED } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import { RealtimePublisher } from '../../realtime/index.ts';
import type { RecomputeProgress } from '../application/ports.ts';

const THROTTLE_MS = 1_000;

/** Bulk recompute progress in realtime: ≤ 1 event per profile per second across workers, always one at the end. */
@Injectable()
export class RealtimeRecomputeProgress implements RecomputeProgress {
  constructor(
    private readonly realtime: RealtimePublisher,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  async progressed(
    organizationId: string,
    progress: Parameters<RecomputeProgress['progressed']>[1],
  ): Promise<void> {
    const key = `bf:scoring:progress:${organizationId}:${progress.profileId}`;
    if ((await this.valkey.set(key, '1', 'PX', THROTTLE_MS, 'NX')) !== 'OK') return;
    await this.publish(organizationId, progress, false);
  }

  async finished(
    organizationId: string,
    progress: Parameters<RecomputeProgress['finished']>[1],
  ): Promise<void> {
    await this.publish(organizationId, progress, true);
  }

  private async publish(
    organizationId: string,
    progress: Parameters<RecomputeProgress['finished']>[1],
    finished: boolean,
  ): Promise<void> {
    await this.realtime.publish(organizationId, {
      type: SCORING_RECOMPUTE_PROGRESSED,
      entity: 'scoring_profile',
      entityId: progress.profileId,
      payload: { ...progress, finished },
    });
  }
}
