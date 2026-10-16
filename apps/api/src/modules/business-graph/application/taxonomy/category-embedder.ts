import { createHash } from 'node:crypto';
import type { AiGateway } from '@bf/ai';
import { DomainError } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { AI_GATEWAY } from '../../../platform/ai/ai.module.ts';
import { APP_ENV, type AppEnv } from '../../../platform/config/app-env.ts';
import { LOGGER } from '../../../platform/logging/logger.ts';
import { TAXONOMY_REPOSITORY, type TaxonomyRepository } from './ports.ts';

export const embeddingTextHash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 32);

export interface EmbedCategoriesResult {
  readonly embedded: number;
  readonly upToDate: number;
  /** Why nothing was embedded (no provider key, budget…), when that happened. */
  readonly skipped?: string;
}

/**
 * Embeds categories whose text (labels + synonyms) or the configured model changed since they were last embedded
 * (purpose `category`). Idempotent and cheap to re-run: unchanged categories cost nothing.
 */
@Injectable()
export class CategoryEmbedder {
  constructor(
    @Inject(TAXONOMY_REPOSITORY) private readonly repository: TaxonomyRepository,
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async embedPending(): Promise<EmbedCategoriesResult> {
    const model = this.env.AI_EMBEDDING_MODEL;
    const targets = await this.repository.listEmbeddingTargets();
    const pending = targets.filter(
      (t) => t.embeddingModel !== model || t.embeddingTextHash !== embeddingTextHash(t.text),
    );
    if (pending.length === 0) return { embedded: 0, upToDate: targets.length };
    try {
      const result = await this.ai.embed(
        pending.map((t) => t.text),
        { purpose: 'category', orgId: null },
      );
      for (const [index, target] of pending.entries()) {
        const vector = result.vectors[index];
        if (!vector) throw new Error(`No embedding returned for category ${target.slug}`);
        await this.repository.saveEmbedding(target.id, vector, model, embeddingTextHash(target.text));
      }
      this.logger.info({ embedded: pending.length, model }, 'categories embedded');
      return { embedded: pending.length, upToDate: targets.length - pending.length };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      // No key or no budget: candidate search falls back to trigram matching until a later run succeeds.
      this.logger.warn({ code: error.code, pending: pending.length }, 'category embeddings skipped');
      return { embedded: 0, upToDate: targets.length - pending.length, skipped: error.code };
    }
  }
}
