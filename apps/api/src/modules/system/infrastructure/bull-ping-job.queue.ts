import { SystemPingJob } from '@bf/contracts';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { getRequestContext } from '../../platform/context/request-context.ts';
import type { PingJobQueue } from '../application/ports.ts';

/** Adapter: PingJobQueue on BullMQ through the typed producer (validation, trace context, idempotent job ids). */
@Injectable()
export class BullPingJobQueue implements PingJobQueue {
  private readonly producer: TypedProducer<typeof SystemPingJob>;

  constructor(@InjectQueue(QUEUES.system.name) queue: Queue) {
    this.producer = new TypedProducer(queue, SystemPingJob);
  }

  enqueue(job: { idempotencyKey: string; sequence: number }): Promise<string> {
    const userId = getRequestContext()?.userId;
    return this.producer.add({ ...job, orgId: null, ...(userId ? { requestedBy: userId } : {}) });
  }
}
