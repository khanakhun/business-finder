import { type DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { BuiltinProfilesSeeder } from './application/builtin-profiles.seeder.ts';
import {
  FACTS_ASSEMBLER,
  RECOMPUTE_PROGRESS,
  SCORING_QUEUE,
  SCORING_REPOSITORY,
} from './application/ports.ts';
import { ScoringService } from './application/scoring.service.ts';
import { ScoringSubscribers } from './application/scoring.subscribers.ts';
import {
  RecomputeProfileCommand,
  RecomputeRunner,
  ScoringQueries,
  SetPrimaryProfileCommand,
} from './application/scoring.use-cases.ts';
import { BullmqScoringQueue, OPENAPI_SCORING_QUEUE } from './infrastructure/bullmq-scoring-queue.ts';
import { DrizzleScoringRepository } from './infrastructure/drizzle-scoring.repository.ts';
import { SqlFactsAssembler } from './infrastructure/facts-assembler.sql.ts';
import { RealtimeRecomputeProgress } from './infrastructure/realtime-recompute-progress.ts';
import { BusinessScoresController, ScoringController } from './interface/http/scoring.controller.ts';
import {
  ScoringComputeProcessor,
  ScoringRecomputeProcessor,
} from './interface/processors/scoring.processors.ts';

/**
 * Scoring (BF-031): explainable scores per offer profile, kept current from domain events, recomputed in bulk, and
 * denormalized for the listing. The engine is pure (domain); this module assembles facts, stores scores and history.
 */
@Module({})
export class ScoringModule {
  private static readonly byMode = new Map<AppMode, DynamicModule>();

  static forRoot(mode: AppMode): DynamicModule {
    let definition = ScoringModule.byMode.get(mode);
    if (!definition) {
      definition = ScoringModule.build(mode);
      ScoringModule.byMode.set(mode, definition);
    }
    return definition;
  }

  private static build(mode: AppMode): DynamicModule {
    return {
      module: ScoringModule,
      controllers: mode === 'worker' ? [] : [BusinessScoresController, ScoringController],
      providers: [
        { provide: SCORING_REPOSITORY, useClass: DrizzleScoringRepository },
        { provide: FACTS_ASSEMBLER, useClass: SqlFactsAssembler },
        mode === 'openapi'
          ? { provide: SCORING_QUEUE, useValue: OPENAPI_SCORING_QUEUE }
          : { provide: SCORING_QUEUE, useClass: BullmqScoringQueue },
        { provide: RECOMPUTE_PROGRESS, useClass: RealtimeRecomputeProgress },
        ScoringService,
        ScoringQueries,
        RecomputeProfileCommand,
        RecomputeRunner,
        SetPrimaryProfileCommand,
        ScoringSubscribers,
        // OpenAPI generation has no database.
        ...(mode === 'openapi' ? [] : [BuiltinProfilesSeeder]),
        ...(mode === 'worker' ? [ScoringComputeProcessor, ScoringRecomputeProcessor] : []),
      ],
      exports: [ScoringService],
    };
  }
}
