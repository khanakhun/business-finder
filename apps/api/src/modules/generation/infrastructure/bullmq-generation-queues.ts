import {
  type EngineId,
  GENERATION_RUN_JOBS,
  GenerationQualityJob,
  GenerationReaperJob,
  type OrgId,
} from '@bf/contracts';
import { jobIdFor, QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import type { GenerationQueues } from '../application/ports.ts';

// The engine queues (one per engine, priorities from the jobs' order), the quality queue and the reaper's minute.

const runKey = (jobId: string, attemptNo: number, wait = 0) => `run:${jobId}:${attemptNo}:${wait}`;

@Injectable()
export class BullmqGenerationQueues implements GenerationQueues {
  private readonly byEngine: Record<
    EngineId,
    { queue: Queue; producer: TypedProducer<(typeof GENERATION_RUN_JOBS)[EngineId]> }
  >;
  private readonly qualityJobs: TypedProducer<typeof GenerationQualityJob>;

  constructor(
    @InjectQueue(QUEUES.generationBlocks.name) blocks: Queue,
    @InjectQueue(QUEUES.generationClaudeAgentSdk.name) sdk: Queue,
    @InjectQueue(QUEUES.generationClaudeCode.name) code: Queue,
    @InjectQueue(QUEUES.generationCodex.name) codex: Queue,
    @InjectQueue(QUEUES.generationFake.name) fake: Queue,
    @InjectQueue(QUEUES.generationQuality.name) quality: Queue,
  ) {
    const entry = <E extends EngineId>(engine: E, queue: Queue) => ({
      queue,
      producer: new TypedProducer(queue, GENERATION_RUN_JOBS[engine]),
    });
    this.byEngine = {
      blocks: entry('blocks', blocks),
      'claude-agent-sdk': entry('claude-agent-sdk', sdk),
      'claude-code': entry('claude-code', code),
      codex: entry('codex', codex),
      fake: entry('fake', fake),
    } as never;
    this.qualityJobs = new TypedProducer(quality, GenerationQualityJob);
  }

  async run(engine: EngineId, input: Parameters<GenerationQueues['run']>[1]): Promise<void> {
    await this.byEngine[engine].producer.add(
      {
        orgId: null,
        idempotencyKey: runKey(input.jobId, input.attemptNo, input.wait),
        jobId: input.jobId,
        attemptNo: input.attemptNo,
      },
      { priority: input.priority, ...(input.delayMs ? { delay: input.delayMs } : {}) },
    );
  }

  private async waiting(engine: EngineId, jobId: string, attemptNo: number) {
    const { queue } = this.byEngine[engine];
    // The first enqueue (a deferred run has another id and keeps its priority until it starts again).
    const job = await queue.getJob(jobIdFor('run', runKey(jobId, attemptNo)));
    if (!job) return undefined;
    const state = await job.getState();
    return state === 'waiting' || state === 'prioritized' || state === 'delayed' ? job : undefined;
  }

  async reprioritize(engine: EngineId, jobId: string, attemptNo: number, priority: number): Promise<boolean> {
    const job = await this.waiting(engine, jobId, attemptNo);
    if (!job) return false;
    await job.changePriority({ priority });
    return true;
  }

  async remove(engine: EngineId, jobId: string, attemptNo: number): Promise<boolean> {
    const job = await this.waiting(engine, jobId, attemptNo);
    if (!job) return false;
    await job.remove();
    return true;
  }

  async quality(input: Parameters<GenerationQueues['quality']>[0]): Promise<void> {
    await this.qualityJobs.add({
      orgId: input.organizationId as OrgId,
      idempotencyKey: `quality:${input.attemptId}`,
      jobId: input.jobId,
      attemptId: input.attemptId,
    });
  }
}

export const GENERATION_REAPER_AUTOSTART = Symbol('GenerationReaperAutostart');

/** Enqueues the reaper once a minute (one job per minute, whatever the number of workers). */
@Injectable()
export class GenerationReaperScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly jobs: TypedProducer<typeof GenerationReaperJob>;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @InjectQueue(QUEUES.generationReaper.name) queue: Queue,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(GENERATION_REAPER_AUTOSTART) private readonly autostart: boolean,
  ) {
    this.jobs = new TypedProducer(queue, GenerationReaperJob);
  }

  onApplicationBootstrap(): void {
    if (!this.autostart) return;
    const run = () =>
      this.tick().catch((error: unknown) => this.logger.error({ err: error }, 'reaper scheduling failed'));
    void run();
    this.timer = setInterval(run, 20_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    await this.jobs.add({ orgId: null, idempotencyKey: `reap:${now.toISOString().slice(0, 16)}` });
  }
}

/** OpenAPI generation boots without Valkey. */
export const OPENAPI_GENERATION_QUEUES: GenerationQueues = {
  run: async () => {},
  reprioritize: async () => false,
  remove: async () => false,
  quality: async () => {},
};
