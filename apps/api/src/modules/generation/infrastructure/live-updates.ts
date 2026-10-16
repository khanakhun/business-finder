import { GENERATION_BATCH_UPDATED, GENERATION_JOB_UPDATED } from '@bf/contracts';
import type { RealtimePublisher } from '../../realtime/index.ts';
import { toBatch, toJob } from '../application/generation.queries.ts';
import type { LiveUpdates, StoredBatch, StoredJob } from '../application/ports.ts';

// The dashboard's live view of generation (BF-039): `generation.job.updated` and `generation.batch.updated` on the
// workspace channel, at most two a second per job or batch (a settled status always goes through).

const MIN_GAP_MS = 500;
const SETTLED = new Set([
  'succeeded',
  'needs_review',
  'failed',
  'cancelled',
  'completed',
  'completed_with_issues',
]);

export class RealtimeLiveUpdates implements LiveUpdates {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly realtime: Pick<RealtimePublisher, 'publish'>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether an update of `key` may go now (and remembers it did). */
  private allow(key: string, status: string): boolean {
    const now = this.now();
    const previous = this.last.get(key);
    if (!SETTLED.has(status) && previous !== undefined && now - previous < MIN_GAP_MS) return false;
    this.last.set(key, now);
    // Forget settled ones: the map stays small on a long-running worker.
    if (SETTLED.has(status)) this.last.delete(key);
    return true;
  }

  async job(job: StoredJob): Promise<void> {
    if (!this.allow(`job:${job.id}`, job.status)) return;
    await this.realtime.publish(job.organizationId, {
      type: GENERATION_JOB_UPDATED,
      entity: 'generation_job',
      entityId: job.id,
      payload: toJob(job),
    });
  }

  async batch(batch: StoredBatch): Promise<void> {
    if (!this.allow(`batch:${batch.id}`, batch.status)) return;
    await this.realtime.publish(batch.organizationId, {
      type: GENERATION_BATCH_UPDATED,
      entity: 'generation_batch',
      entityId: batch.id,
      payload: toBatch(batch),
    });
  }
}
