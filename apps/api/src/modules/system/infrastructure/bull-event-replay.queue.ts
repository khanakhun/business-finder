import { EventDeliveryJob } from '@bf/contracts';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { EventReplayQueue } from '../application/ports.ts';

/** Adapter: an outbox delivery job on the `events` queue (validated, trace context added). */
@Injectable()
export class BullEventReplayQueue implements EventReplayQueue {
  private readonly producer: TypedProducer<typeof EventDeliveryJob>;

  constructor(@InjectQueue(QUEUES.events.name) queue: Queue) {
    this.producer = new TypedProducer(queue, EventDeliveryJob);
  }

  enqueue(job: Parameters<EventReplayQueue['enqueue']>[0]): Promise<string> {
    return this.producer.add(job);
  }
}
