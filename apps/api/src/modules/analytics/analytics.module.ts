import { type DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { AnalyticsQueries } from './application/analytics.queries.ts';
import { AnalyticsBackfill } from './application/backfill.ts';
import { FactIngestor } from './application/fact-ingestor.ts';
import { FACTS_MAINTENANCE, FACTS_STORE } from './application/ports.ts';
import { AnalyticsReconcile } from './application/reconcile.ts';
import { AnalyticsRefresh } from './application/refresh.ts';
import { DrizzleFactsStore } from './infrastructure/drizzle-facts.store.ts';
import { AnalyticsController } from './interface/http/analytics.controller.ts';

const instances = new Map<AppMode, DynamicModule>();

/**
 * Analytics (BF-058): facts captured from domain events (worker: the outbox subscribers), a semantic layer of
 * metrics and dimensions compiled to parameterized SQL, and the query and export API.
 */
@Module({})
export class AnalyticsModule {
  static forRoot(mode: AppMode): DynamicModule {
    const existing = instances.get(mode);
    if (existing) return existing;
    const module: DynamicModule = {
      module: AnalyticsModule,
      controllers: mode === 'worker' ? [] : [AnalyticsController],
      providers: [
        DrizzleFactsStore,
        { provide: FACTS_STORE, useExisting: DrizzleFactsStore },
        { provide: FACTS_MAINTENANCE, useExisting: DrizzleFactsStore },
        AnalyticsQueries,
        AnalyticsBackfill,
        FactIngestor,
        // The 15-minute refresh and the nightly reconciliation run in the worker.
        ...(mode === 'worker' ? [AnalyticsRefresh, AnalyticsReconcile] : []),
      ],
      exports: [AnalyticsBackfill],
    };
    instances.set(mode, module);
    return module;
  }
}
