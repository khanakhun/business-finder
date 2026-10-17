import { GENERATION_RUN_JOBS, GenerationQualityJob, GenerationReaperJob } from '@bf/contracts';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { z } from 'zod';
import { TypedProcessor } from '../../../platform/queue/typed-processor.ts';
import { GenerationQuality } from '../../application/generation.quality.ts';
import { GenerationRunner } from '../../application/generation.runner.ts';
import { SANDBOX_JANITOR, type SandboxSweeper } from '../../application/sandbox.ports.ts';

// One processor per engine queue (the same runner: Template Method), the quality step and the reaper (BF-039).

type RunPayload = z.output<(typeof GENERATION_RUN_JOBS)['fake']['schema']>;

/** The wait count is the idempotency key's last part (`run:<job>:<attempt>:<wait>`): a deferred run carries it on. */
const waitOf = (key: string) => Number(key.split(':').at(-1) ?? '0') || 0;

/** Decorated so Nest reads its constructor's parameters (the subclasses declare none). */
@Injectable()
abstract class RunProcessor extends TypedProcessor<
  (typeof GENERATION_RUN_JOBS)[keyof typeof GENERATION_RUN_JOBS],
  { readonly outcome: string }
> {
  constructor(private readonly attempts: GenerationRunner) {
    super();
  }

  async handle(payload: RunPayload, context: JobContext) {
    const outcome = await this.attempts.run(
      payload.jobId,
      payload.attemptNo,
      context.logger,
      waitOf(payload.idempotencyKey),
    );
    context.logger.info(
      { jobId: payload.jobId, attemptNo: payload.attemptNo, outcome },
      'generation attempt',
    );
    return { outcome };
  }
}

@Processor(QUEUES.generationBlocks.name, { concurrency: QUEUES.generationBlocks.concurrency })
export class GenerationBlocksProcessor extends RunProcessor {
  protected readonly definition = GENERATION_RUN_JOBS.blocks;
}

@Processor(QUEUES.generationClaudeAgentSdk.name, { concurrency: QUEUES.generationClaudeAgentSdk.concurrency })
export class GenerationClaudeAgentSdkProcessor extends RunProcessor {
  protected readonly definition = GENERATION_RUN_JOBS['claude-agent-sdk'];
}

@Processor(QUEUES.generationClaudeCode.name, { concurrency: QUEUES.generationClaudeCode.concurrency })
export class GenerationClaudeCodeProcessor extends RunProcessor {
  protected readonly definition = GENERATION_RUN_JOBS['claude-code'];
}

@Processor(QUEUES.generationCodex.name, { concurrency: QUEUES.generationCodex.concurrency })
export class GenerationCodexProcessor extends RunProcessor {
  protected readonly definition = GENERATION_RUN_JOBS.codex;
}

@Processor(QUEUES.generationFake.name, { concurrency: QUEUES.generationFake.concurrency })
export class GenerationFakeProcessor extends RunProcessor {
  protected readonly definition = GENERATION_RUN_JOBS.fake;
}

@Processor(QUEUES.generationQuality.name, { concurrency: QUEUES.generationQuality.concurrency })
export class GenerationQualityProcessor extends TypedProcessor<
  typeof GenerationQualityJob,
  { readonly outcome: string }
> {
  protected readonly definition = GenerationQualityJob;

  constructor(private readonly quality: GenerationQuality) {
    super();
  }

  async handle(payload: z.output<typeof GenerationQualityJob.schema>, context: JobContext) {
    const outcome = await this.quality.evaluate(payload.jobId, payload.attemptId, context.logger);
    context.logger.info({ jobId: payload.jobId, outcome }, 'generation quality');
    return { outcome };
  }
}

@Processor(QUEUES.generationReaper.name, { concurrency: QUEUES.generationReaper.concurrency })
export class GenerationReaperProcessor extends TypedProcessor<
  typeof GenerationReaperJob,
  { readonly reaped: number; readonly events: number; readonly sandboxes: number }
> {
  protected readonly definition = GenerationReaperJob;

  constructor(
    private readonly quality: GenerationQuality,
    @Optional() @Inject(SANDBOX_JANITOR) private readonly janitor?: SandboxSweeper | null,
  ) {
    super();
  }

  async handle(_payload: z.output<typeof GenerationReaperJob.schema>, context: JobContext) {
    const result = await this.quality.reap(context.logger);
    if (result.reaped > 0) context.logger.warn(result, 'generation attempts reaped');
    // Every fifth minute (the reaper runs each minute): stale sandbox containers (BF-043).
    let sandboxes = 0;
    if (this.janitor && new Date().getUTCMinutes() % 5 === 0) {
      sandboxes = await this.janitor.sweep(new Date()).catch((error: unknown) => {
        context.logger.error({ err: error }, 'sandbox janitor failed');
        return 0;
      });
      if (sandboxes > 0) context.logger.warn({ sandboxes }, 'stale sandboxes removed');
    }
    return { ...result, sandboxes };
  }
}
