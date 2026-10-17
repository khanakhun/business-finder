import { metrics } from '@bf/observability';
import { QUEUE_NAMES, QUEUES } from '@bf/queue';
import { getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { LOGGER, type Logger } from '../logging/logger.ts';

// Queue backlog metrics (BF-061): every 30 s, per queue, the jobs in each state and the age of the oldest waiting
// job — the alerts on stuck pipelines (outreach send, the outbox) and the queues dashboard read them. Worker only.

const SAMPLE_MS = 30_000;
const STATES = ['waiting', 'active', 'delayed', 'failed', 'prioritized'] as const;

const jobs = () =>
  metrics.gauge({ name: 'bf_queue_jobs', help: 'Jobs per queue and state', labelNames: ['queue', 'state'] });
const oldestWaiting = () =>
  metrics.gauge({
    name: 'bf_queue_oldest_waiting_age_seconds',
    help: 'Age of the oldest job waiting to run, per queue (0 when none waits)',
    labelNames: ['queue'],
  });

@Injectable()
export class QueueMetricsSampler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sample(), SAMPLE_MS);
    this.timer.unref();
    void this.sample();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sample(): Promise<void> {
    const now = Date.now();
    for (const key of QUEUE_NAMES) {
      const name = QUEUES[key].name;
      try {
        const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
        const counts = await queue.getJobCounts(...STATES);
        for (const state of STATES) jobs().set({ queue: name, state }, counts[state] ?? 0);
        // The oldest first (asc): its creation time.
        const [oldest] = await queue.getJobs(['wait', 'prioritized'], 0, 0, true);
        oldestWaiting().set({ queue: name }, oldest ? Math.max(0, (now - oldest.timestamp) / 1000) : 0);
      } catch (error) {
        this.logger.warn({ err: error, queue: name }, 'queue metrics sample failed');
      }
    }
  }
}
