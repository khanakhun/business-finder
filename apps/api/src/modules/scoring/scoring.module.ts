import type { ApiEnv } from '@bf/config';
import { type DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { APP_ENV, type AppEnv } from '../platform/config/app-env.ts';
import { IntelClient } from '../platform/intel/intel-client.ts';
import { S3ObjectStorage } from '../platform/storage/s3-object-storage.ts';
import { OBJECT_PRESIGNER, S3Presigner } from '../platform/storage/s3-presigner.ts';
import { BuiltinProfilesSeeder } from './application/builtin-profiles.seeder.ts';
import { DatasetBuilder } from './application/ml/dataset-builder.ts';
import { ModelTrainer } from './application/ml/model-trainer.ts';
import {
  ML_REPOSITORY,
  ML_STORAGE,
  MODEL_REGISTRY,
  MODEL_TRAINER_PORT,
  TRAINING_QUEUE,
} from './application/ml/ports.ts';
import {
  FACTS_ASSEMBLER,
  RECOMPUTE_PROGRESS,
  SCORING_QUEUE,
  SCORING_REPOSITORY,
} from './application/ports.ts';
import { ScoringEditorQueries, ScoringProfileCommands } from './application/profile-management.use-cases.ts';
import { ScoringService } from './application/scoring.service.ts';
import { ScoringSubscribers } from './application/scoring.subscribers.ts';
import {
  RecomputeBusinessCommand,
  RecomputeProfileCommand,
  RecomputeRunner,
  ScoringQueries,
  SetPrimaryProfileCommand,
} from './application/scoring.use-cases.ts';
import { BullmqScoringQueue, OPENAPI_SCORING_QUEUE } from './infrastructure/bullmq-scoring-queue.ts';
import { DrizzleScoringRepository } from './infrastructure/drizzle-scoring.repository.ts';
import { SqlFactsAssembler } from './infrastructure/facts-assembler.sql.ts';
import { BullmqTrainingQueue } from './infrastructure/ml/bullmq-training-queue.ts';
import { DrizzleMlRepository } from './infrastructure/ml/drizzle-ml.repository.ts';
import { IntelModelTrainer } from './infrastructure/ml/intel-model-trainer.ts';
import { RealtimeRecomputeProgress } from './infrastructure/realtime-recompute-progress.ts';
import { ScoringMlController } from './interface/http/ml.controller.ts';
import {
  BusinessScoresController,
  ScoringController,
  ScoringProfilesController,
} from './interface/http/scoring.controller.ts';
import { ScoringMlTrainProcessor } from './interface/processors/ml-train.processor.ts';
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
      controllers:
        mode === 'worker'
          ? []
          : [BusinessScoresController, ScoringController, ScoringProfilesController, ScoringMlController],
      providers: [
        { provide: SCORING_REPOSITORY, useClass: DrizzleScoringRepository },
        { provide: FACTS_ASSEMBLER, useClass: SqlFactsAssembler },
        mode === 'openapi'
          ? { provide: SCORING_QUEUE, useValue: OPENAPI_SCORING_QUEUE }
          : { provide: SCORING_QUEUE, useClass: BullmqScoringQueue },
        { provide: RECOMPUTE_PROGRESS, useClass: RealtimeRecomputeProgress },
        ScoringService,
        ScoringQueries,
        RecomputeBusinessCommand,
        RecomputeProfileCommand,
        RecomputeRunner,
        SetPrimaryProfileCommand,
        ScoringProfileCommands,
        ScoringEditorQueries,
        ScoringSubscribers,
        // BF-059: outcome-trained scoring.
        DrizzleMlRepository,
        { provide: ML_REPOSITORY, useExisting: DrizzleMlRepository },
        { provide: MODEL_REGISTRY, useExisting: DrizzleMlRepository },
        IntelClient,
        { provide: MODEL_TRAINER_PORT, useClass: IntelModelTrainer },
        mode === 'openapi'
          ? { provide: TRAINING_QUEUE, useValue: { enqueue: async () => {} } }
          : { provide: TRAINING_QUEUE, useClass: BullmqTrainingQueue },
        {
          provide: OBJECT_PRESIGNER,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) => new S3Presigner(env as ApiEnv),
        },
        ModelTrainer,
        {
          provide: ML_STORAGE,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) =>
            new S3ObjectStorage(env as ApiEnv, (env as ApiEnv).S3_BUCKET_ARTIFACTS),
        },
        DatasetBuilder,
        // OpenAPI generation has no database.
        ...(mode === 'openapi' ? [] : [BuiltinProfilesSeeder]),
        ...(mode === 'worker'
          ? [ScoringComputeProcessor, ScoringRecomputeProcessor, ScoringMlTrainProcessor]
          : []),
      ],
      exports: [ScoringService],
    };
  }
}
