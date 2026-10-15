import type { EmbeddingSource } from '../domain/embedding-text.ts';

export interface EmbeddingSourceRow extends EmbeddingSource {
  readonly embeddingModel: string | null;
  readonly embeddingTextHash: string | null;
}

export interface BusinessEmbeddingRepository {
  /** Sources of these businesses (merged-away ones left out). */
  sources(ids: readonly string[]): Promise<EmbeddingSourceRow[]>;
  /** Live businesses in id order after `afterId` (backfill paging). */
  sourcesAfter(afterId: string | null, limit: number): Promise<EmbeddingSourceRow[]>;
  save(id: string, vector: readonly number[], model: string, textHash: string): Promise<void>;
}
export const BUSINESS_EMBEDDING_REPOSITORY = Symbol('BusinessEmbeddingRepository');

export interface EmbedQueue {
  /** Enqueues an embedding; the same business, model and text collapse into one job. */
  enqueue(businessId: string, model: string, textHash: string): Promise<void>;
}
export const EMBED_QUEUE = Symbol('EmbedQueue');
