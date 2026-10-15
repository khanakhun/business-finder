import { SearchEmbedBusinessJob } from '@bf/contracts';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { EmbedQueue } from '../application/embedding-ports.ts';

@Injectable()
export class BullmqEmbedQueue implements EmbedQueue {
  private readonly producer: TypedProducer<typeof SearchEmbedBusinessJob>;

  constructor(@InjectQueue(QUEUES.search.name) queue: Queue) {
    this.producer = new TypedProducer(queue, SearchEmbedBusinessJob);
  }

  async enqueue(businessId: string, model: string, textHash: string): Promise<void> {
    await this.producer.add({
      businessId,
      orgId: null,
      idempotencyKey: `${businessId}:${model}:${textHash}`,
    });
  }
}
