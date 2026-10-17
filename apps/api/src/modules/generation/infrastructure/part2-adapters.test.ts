import { describe, expect, it, vi } from 'vitest';
import type { StoredBatch, StoredJob } from '../application/ports.ts';
import { JobEventTail } from './job-event-tail.ts';
import { RealtimeLiveUpdates } from './live-updates.ts';
import { PROMETHEUS_TELEMETRY } from './metrics.ts';

const job = (status: StoredJob['status']): StoredJob =>
  ({
    id: '0199e0a0-0000-7000-8000-0000000000a1',
    batchId: '0199e0a0-0000-7000-8000-0000000000b1',
    organizationId: 'org',
    businessId: 'biz',
    businessName: 'Salon',
    siteId: null,
    briefOverrides: null,
    position: 0,
    priority: 1,
    engineRequested: 'auto',
    engineCurrent: 'fake',
    engineSelectionReason: 'r',
    status,
    attemptCount: 1,
    engineAttempts: 1,
    maxAttemptsPerEngine: 2,
    failoverChain: [],
    budgetUsd: 1,
    costUsd: 0.05,
    resultVersionId: null,
    publishedUrl: null,
    qualityScore: null,
    errorCode: null,
    errorMessage: null,
    cancelRequestedAt: null,
    dispatchedAt: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
  }) as StoredJob;

describe('live updates', () => {
  it('sends at most two updates a second per job, always the settled one', async () => {
    const publish = vi.fn(async (..._args: unknown[]) => ({}) as never);
    let now = 0;
    const live = new RealtimeLiveUpdates({ publish }, () => now);
    await live.job(job('running'));
    await live.job(job('running'));
    now = 300;
    await live.job(job('running'));
    expect(publish).toHaveBeenCalledTimes(1);
    now = 600;
    await live.job(job('running'));
    await live.job(job('succeeded'));
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({
      type: 'generation.job.updated',
      entity: 'generation_job',
    });
    await live.batch({
      id: 'b',
      organizationId: 'org',
      status: 'completed',
      counts: {},
      createdAt: new Date(),
    } as unknown as StoredBatch);
    expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({ type: 'generation.batch.updated' });
  });

  it('records metrics without failing', () => {
    PROMETHEUS_TELEMETRY.leaseWait('fake');
    PROMETHEUS_TELEMETRY.queueWait('fake', 1.5);
    PROMETHEUS_TELEMETRY.phase('fake', 'run', 2);
    PROMETHEUS_TELEMETRY.sandboxes(3);
    PROMETHEUS_TELEMETRY.settled(job('succeeded'), 'succeeded');
  });
});

describe('job event tail', () => {
  it('reads events and statuses from the job stream, and stops', async () => {
    const reads = [
      [
        [
          'gen:job:j',
          [
            [
              '1-0',
              [
                'seq',
                '1',
                'attempt',
                '2',
                'at',
                '2026-10-17T08:00:00.000Z',
                'event',
                JSON.stringify({ type: 'heartbeat' }),
              ],
            ],
            ['2-0', ['status', 'succeeded']],
          ],
        ],
      ],
    ];
    const connection = {
      xread: vi.fn(async () => {
        const next = reads.shift();
        if (next) return next;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return null;
      }),
      disconnect: vi.fn(),
    };
    const tail = new JobEventTail({ duplicate: () => connection as never });
    const seen: unknown[] = [];
    const stop = await tail.follow('j', (entry) => seen.push(entry));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      { kind: 'event', seq: 1, event: { type: 'heartbeat' }, attempt: 2, at: '2026-10-17T08:00:00.000Z' },
      { kind: 'status', status: 'succeeded' },
    ]);
    stop();
    expect(connection.disconnect).toHaveBeenCalled();
    // The next read after the first starts from the last id seen.
    expect(connection.xread.mock.calls[1]).toEqual([
      'COUNT',
      100,
      'BLOCK',
      5_000,
      'STREAMS',
      'gen:job:j',
      '2-0',
    ]);
  });
});
