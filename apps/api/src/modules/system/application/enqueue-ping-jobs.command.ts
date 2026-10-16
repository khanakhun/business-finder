import { newId, type PingJobsAccepted, type PingJobsRequest } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PING_JOB_QUEUE, type PingJobQueue } from './ports.ts';

/** Command use case: enqueue `count` ping jobs. Idempotent when the caller supplies a key. */
@Injectable()
export class EnqueuePingJobsCommand {
  constructor(@Inject(PING_JOB_QUEUE) private readonly queue: PingJobQueue) {}

  async execute(input: PingJobsRequest): Promise<PingJobsAccepted> {
    const requestKey = input.idempotencyKey ?? newId();
    const jobIds: string[] = [];
    for (let sequence = 0; sequence < input.count; sequence++) {
      jobIds.push(await this.queue.enqueue({ idempotencyKey: `${requestKey}:${sequence}`, sequence }));
    }
    return { jobIds };
  }
}
