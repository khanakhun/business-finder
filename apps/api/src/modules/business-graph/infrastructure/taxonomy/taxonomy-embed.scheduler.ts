import { type Clock, TaxonomyEmbedCategoriesJob } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { LOGGER } from '../../../platform/logging/logger.ts';

/**
 * Worker startup enqueues one embedding run, so categories seeded or edited by a deploy get embedded. Cheap when
 * nothing changed (the embedder skips up-to-date categories).
 */
@Injectable()
export class TaxonomyEmbedScheduler implements OnApplicationBootstrap {
  private readonly producer: TypedProducer<typeof TaxonomyEmbedCategoriesJob>;

  constructor(
    @InjectQueue(QUEUES.taxonomy.name) queue: Queue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.producer = new TypedProducer(queue, TaxonomyEmbedCategoriesJob);
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      // One run per minute at most, however many workers start together.
      const minute = Math.floor(this.clock.now().getTime() / 60_000);
      await this.producer.add({ idempotencyKey: `taxonomy-embed:${minute}`, orgId: null, reason: 'startup' });
    } catch (error) {
      this.logger.warn({ err: error }, 'could not enqueue taxonomy embeddings');
    }
  }
}
