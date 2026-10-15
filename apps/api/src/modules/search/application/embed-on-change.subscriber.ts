import { BusinessCreated, BusinessEnriched, BusinessUpdated, type DomainEvent } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { BusinessEmbedder } from './business-embedder.ts';
import { EMBED_QUEUE, type EmbedQueue } from './embedding-ports.ts';

/** Keeps business embeddings current (BF-022): a created, updated or enriched business is queued if its text
 * changed. */
@Injectable()
export class EmbedOnChangeSubscriber {
  constructor(
    private readonly embedder: BusinessEmbedder,
    @Inject(EMBED_QUEUE) private readonly queue: EmbedQueue,
  ) {}

  // `business.enriched` (BF-027): a new website crawl can change the text without changing a golden field.
  @OnDomainEvent([BusinessCreated, BusinessUpdated, BusinessEnriched], { id: 'search.embed-business' })
  async onChange(
    event:
      | DomainEvent<typeof BusinessCreated>
      | DomainEvent<typeof BusinessUpdated>
      | DomainEvent<typeof BusinessEnriched>,
  ): Promise<void> {
    for (const stale of await this.embedder.staleOf([event.payload.businessId])) {
      await this.queue.enqueue(stale.id, this.embedder.model, stale.hash);
    }
  }
}
