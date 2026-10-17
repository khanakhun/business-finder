import { type DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { AnalyticsQueries } from './application/analytics.queries.ts';
import { AnalyticsBackfill } from './application/backfill.ts';
import { FactIngestor } from './application/fact-ingestor.ts';
import { FACTS_STORE } from './application/ports.ts';
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
        { provide: FACTS_STORE, useClass: DrizzleFactsStore },
        AnalyticsQueries,
        AnalyticsBackfill,
        FactIngestor,
      ],
      exports: [AnalyticsBackfill],
    };
    instances.set(mode, module);
    return module;
  }
}
