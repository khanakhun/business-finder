import { createHash } from 'node:crypto';
import { type AiGateway, AiProviderNotConfiguredError } from '@bf/ai';
import { BudgetExceededError } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { AI_GATEWAY } from '../../platform/ai/ai.module.ts';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import { composeEmbeddingText } from '../domain/embedding-text.ts';
import {
  BUSINESS_EMBEDDING_REPOSITORY,
  type BusinessEmbeddingRepository,
  type EmbeddingSourceRow,
} from './embedding-ports.ts';

export const embeddingTextHash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 32);

export interface StaleEmbedding {
  readonly id: string;
  readonly text: string;
  readonly hash: string;
}

export interface EmbedReport {
  readonly embedded: number;
  readonly upToDate: number;
  /** Why nothing was embedded (no provider key, budget spent), when that happened. */
  readonly skipped?: string;
}

const ADD = (a: EmbedReport, b: EmbedReport): EmbedReport => ({
  embedded: a.embedded + b.embedded,
  upToDate: a.upToDate + b.upToDate,
  ...((b.skipped ?? a.skipped) ? { skipped: b.skipped ?? a.skipped } : {}),
});

/**
 * Business embeddings (BF-022, purpose `business`): composes each business's text, and embeds it only when the text
 * or the configured model changed since the stored vector. Costs land in `llm_calls` as `embed.business`.
 */
@Injectable()
export class BusinessEmbedder {
  constructor(
    @Inject(BUSINESS_EMBEDDING_REPOSITORY) private readonly repository: BusinessEmbeddingRepository,
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  get model(): string {
    return this.env.AI_EMBEDDING_MODEL;
  }

  stale(rows: readonly EmbeddingSourceRow[]): StaleEmbedding[] {
    return rows.flatMap((row) => {
      const text = composeEmbeddingText(row);
      const hash = embeddingTextHash(text);
      return row.embeddingModel === this.model && row.embeddingTextHash === hash
        ? []
        : [{ id: row.id, text, hash }];
    });
  }

  async staleOf(ids: readonly string[]): Promise<StaleEmbedding[]> {
    return this.stale(await this.repository.sources(ids));
  }

  /** Embeds these businesses if stale. No key or no budget is a skip (logged); provider outages throw (retry). */
  async embed(ids: readonly string[]): Promise<EmbedReport> {
    const rows = await this.repository.sources(ids);
    return this.embedRows(rows);
  }

  /** Every live business, in id order and batches; re-running resumes (up-to-date rows cost nothing). */
  async reindex(options: {
    readonly batchSize: number;
    readonly onBatch?: (report: EmbedReport) => void;
  }): Promise<EmbedReport> {
    let total: EmbedReport = { embedded: 0, upToDate: 0 };
    let after: string | null = null;
    for (;;) {
      const rows = await this.repository.sourcesAfter(after, options.batchSize);
      if (rows.length === 0) return total;
      const report = await this.embedRows(rows);
      total = ADD(total, report);
      options.onBatch?.(total);
      if (report.skipped) return total;
      after = rows.at(-1)?.id ?? null;
    }
  }

  private async embedRows(rows: readonly EmbeddingSourceRow[]): Promise<EmbedReport> {
    const pending = this.stale(rows);
    const upToDate = rows.length - pending.length;
    if (pending.length === 0) return { embedded: 0, upToDate };
    try {
      const { vectors } = await this.ai.embed(
        pending.map((p) => p.text),
        { purpose: 'business', orgId: null },
      );
      for (const [index, item] of pending.entries()) {
        const vector = vectors[index];
        if (!vector) throw new Error(`No embedding returned for business ${item.id}`);
        await this.repository.save(item.id, vector, this.model, item.hash);
      }
      return { embedded: pending.length, upToDate };
    } catch (error) {
      if (!(error instanceof AiProviderNotConfiguredError || error instanceof BudgetExceededError))
        throw error;
      // Retrying cannot help: semantic ranking skips these businesses until a later run succeeds.
      this.logger.warn({ code: error.code, pending: pending.length }, 'business embeddings skipped');
      return { embedded: 0, upToDate, skipped: error.code };
    }
  }
}
