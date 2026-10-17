import { Inject, Injectable } from '@nestjs/common';
import { FACTS_STORE, type FactSourceName, type FactsStore } from './ports.ts';

// The backfill (BF-058): facts rebuilt from the source tables for everything since a date (`pnpm analytics:backfill
// --since 2026-01-01`). The same SQL as live ingestion and the same keys, so running it twice, or after live
// ingestion started, adds nothing twice. Dimensions are taken now: a backfilled email carries today's tier, not the
// tier when it was sent (live facts carry the tier at the event).

export const BACKFILL_ORDER: readonly FactSourceName[] = [
  'businessTracked',
  'generationFinished',
  'previewPublished',
  'siteViewsDaily',
  'leadCaptured',
  'emailSent',
  'replyTriaged',
  'pipelineFromActivities',
  'manualContact',
  'discoveryFinished',
  'llmCosts',
  'providerCosts',
];

@Injectable()
export class AnalyticsBackfill {
  constructor(@Inject(FACTS_STORE) private readonly store: FactsStore) {}

  async run(since: Date, organizationId?: string): Promise<Record<string, number>> {
    const written: Record<string, number> = {};
    for (const source of BACKFILL_ORDER)
      written[source] = await this.store.ingest(source, { since, organizationId });
    return written;
  }
}
