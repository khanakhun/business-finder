import { DomainError, type IngestOutcome, type SourceRecordInput } from '@bf/contracts';
import { type Logger, startSpan } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { LOGGER } from '../../../platform/logging/logger.ts';
import {
  type IngestOptions,
  type IngestResult,
  IngestSourceRecordCommand,
} from './ingest-source-record.command.ts';

export type IngestBatchCounts = Record<IngestOutcome, number>;

export interface IngestBatchResult {
  readonly counts: IngestBatchCounts;
  readonly results: ReadonlyArray<
    IngestResult | { readonly outcome: 'failed'; readonly providerRef: string; readonly code: string }
  >;
}

/**
 * Ingests a page of source records sequentially (one transaction each, BF-016). A failing record is counted and
 * logged (by provider ref, never its content) without stopping the batch.
 */
@Injectable()
export class IngestBatchCommand {
  constructor(
    private readonly ingest: IngestSourceRecordCommand,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async execute(
    records: readonly SourceRecordInput[],
    options: IngestOptions = {},
  ): Promise<IngestBatchResult> {
    return startSpan('ingest.batch', { 'bf.ingest.size': records.length }, async () => {
      const counts: IngestBatchCounts = {
        created: 0,
        merged: 0,
        possible_duplicate: 0,
        unchanged: 0,
        failed: 0,
      };
      const results: Array<IngestBatchResult['results'][number]> = [];
      for (const record of records) {
        try {
          const result = await this.ingest.execute(record, options);
          counts[result.outcome]++;
          results.push(result);
        } catch (error) {
          counts.failed++;
          const code = error instanceof DomainError ? error.code : 'INTERNAL';
          const providerRef = String((record as { providerRef?: unknown }).providerRef ?? '').slice(0, 300);
          // Never the error itself: database errors quote the query parameters (names, phones, emails).
          this.logger.warn(
            {
              provider: (record as { provider?: unknown }).provider,
              providerRef,
              code,
              errorName: error instanceof Error ? error.name : typeof error,
              dbCode: (error as { cause?: { code?: unknown } }).cause?.code,
            },
            'source record ingestion failed',
          );
          results.push({ outcome: 'failed', providerRef, code });
        }
      }
      this.logger.info({ ...counts }, 'ingest batch done');
      return { counts, results };
    });
  }
}
