import { describe, expect, it } from 'vitest';
import { EnqueuePingJobsCommand } from './enqueue-ping-jobs.command.ts';
import type { PingJobQueue } from './ports.ts';

const fakeQueue = () => {
  const enqueued: Array<{ idempotencyKey: string; sequence: number }> = [];
  const queue: PingJobQueue = {
    enqueue: async (job) => {
      enqueued.push(job);
      return `job-${job.sequence}`;
    },
  };
  return { queue, enqueued };
};

describe('EnqueuePingJobsCommand', () => {
  it('enqueues one job per count with stable keys derived from the request key', async () => {
    const { queue, enqueued } = fakeQueue();
    const result = await new EnqueuePingJobsCommand(queue).execute({ count: 3, idempotencyKey: 'req-1' });
    expect(result).toEqual({ jobIds: ['job-0', 'job-1', 'job-2'] });
    expect(enqueued.map((j) => j.idempotencyKey)).toEqual(['req-1:0', 'req-1:1', 'req-1:2']);
  });

  it('generates a fresh key when none is given', async () => {
    const { queue, enqueued } = fakeQueue();
    await new EnqueuePingJobsCommand(queue).execute({ count: 1 });
    expect(enqueued[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}:0$/);
  });
});
