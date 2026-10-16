import type { ApiEnv } from '@bf/config';
import type { Clock } from '@bf/contracts';
import { type DynamicModule, Inject, Module, type OnModuleInit } from '@nestjs/common';
import {
  BusinessGraphModule,
  IngestSourceRecordCommand,
  ReplaceWebsiteMediaCommand,
} from '../business-graph/index.ts';
import { CLOCK } from '../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { IntelClient } from '../platform/intel/intel-client.ts';
import { RATE_LIMITER, ValkeyRateLimiter } from '../platform/rate-limit/valkey-rate-limiter.ts';
import { ARTIFACT_STORAGE, InMemoryObjectStorage } from '../platform/storage/object-storage.ts';
import { S3ObjectStorage } from '../platform/storage/s3-object-storage.ts';
import { RealtimeModule } from '../realtime/index.ts';
import {
  AutoEnrichSubscriber,
  BulkEnrichCommand,
  NightlyRefresh,
} from './application/enrichment.triggers.ts';
import {
  EnrichmentPlanning,
  EnrichmentQueries,
  EstimateEnrichmentQuery,
  StartEnrichmentCommand,
} from './application/enrichment.use-cases.ts';
import {
  ENRICHMENT_QUEUE,
  ENRICHMENT_REPOSITORY,
  type EnrichmentQueue,
  NO_SOLICITATION_MARKERS,
  type NoSolicitationMarkers,
  RUN_PROGRESS,
  SITE_INTEL,
  type SiteIntelPort,
  SUBJECT_READER,
  WEBSITE_SNAPSHOTS,
  type WebsiteSnapshotRepository,
} from './application/ports.ts';
import { EnrichmentOrchestrator } from './application/run-orchestrator.ts';
import { StepRegistry } from './application/step-registry.ts';
import { BullmqEnrichmentQueue } from './infrastructure/bullmq-enrichment-queue.ts';
import { DrizzleEnrichmentRepository } from './infrastructure/drizzle-enrichment.repository.ts';
import { DrizzleSubjectReader } from './infrastructure/drizzle-subject-reader.ts';
import {
  DrizzleNoSolicitationMarkers,
  DrizzleWebsiteSnapshotRepository,
} from './infrastructure/drizzle-website.repository.ts';
import {
  EnrichmentReconciler,
  EnrichmentScheduler,
  MAINTENANCE_AUTOSTART,
} from './infrastructure/enrichment-maintenance.ts';
import { RealtimeEnrichmentProgress } from './infrastructure/realtime-run-progress.ts';
import { FakeSiteIntel, IntelSiteIntel } from './infrastructure/site-intel.adapters.ts';
import { SiteIntelStep } from './infrastructure/steps/site-intel.step.ts';
import {
  BusinessEnrichmentController,
  EnrichmentController,
} from './interface/http/enrichment.controller.ts';
import {
  EnrichmentRefreshProcessor,
  EnrichmentRunProcessor,
  EnrichmentStepProcessor,
} from './interface/processors/enrichment.processors.ts';

/** The fake site intel exists only in tests and E2E (refused in production). */
function fakeSiteIntelEnabled(env: ApiEnv): boolean {
  if (!env.FAKE_SITE_INTEL) return false;
  if (env.NODE_ENV === 'production') throw new Error('FAKE_SITE_INTEL is refused in production');
  return true;
}

const noQueue = () => Promise.reject(new Error('no queue in openapi mode'));
const OPENAPI_QUEUE: EnrichmentQueue = { start: noQueue, step: noQueue, cancel: noQueue, refresh: noQueue };

/**
 * Enrichment (BF-027): the step framework (registry, DAG planner, freshness, budgets, idempotent execution with a
 * reconciler), the `site_intel` step, manual/bulk/discovery/nightly triggers, and the website facts read side.
 * Other modules add steps by injecting `StepRegistry` and registering theirs.
 */
@Module({})
export class EnrichmentModule implements OnModuleInit {
  constructor(
    private readonly registry: StepRegistry,
    @Inject(SITE_INTEL) private readonly siteIntel: SiteIntelPort,
    @Inject(WEBSITE_SNAPSHOTS) private readonly snapshots: WebsiteSnapshotRepository,
    @Inject(NO_SOLICITATION_MARKERS) private readonly markers: NoSolicitationMarkers,
    private readonly media: ReplaceWebsiteMediaCommand,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly ingest: IngestSourceRecordCommand,
  ) {}

  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: EnrichmentModule,
      imports: [BusinessGraphModule.forRoot(mode), RealtimeModule.forRoot(mode)],
      controllers: mode === 'worker' ? [] : [BusinessEnrichmentController, EnrichmentController],
      providers: [
        { provide: ENRICHMENT_REPOSITORY, useClass: DrizzleEnrichmentRepository },
        { provide: SUBJECT_READER, useClass: DrizzleSubjectReader },
        { provide: WEBSITE_SNAPSHOTS, useClass: DrizzleWebsiteSnapshotRepository },
        { provide: NO_SOLICITATION_MARKERS, useClass: DrizzleNoSolicitationMarkers },
        // OpenAPI generation connects to nothing: no queues or buckets in that mode.
        mode === 'openapi'
          ? { provide: ENRICHMENT_QUEUE, useValue: OPENAPI_QUEUE }
          : { provide: ENRICHMENT_QUEUE, useClass: BullmqEnrichmentQueue },
        {
          provide: ARTIFACT_STORAGE,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) =>
            mode === 'openapi'
              ? new InMemoryObjectStorage()
              : new S3ObjectStorage(env as ApiEnv, (env as ApiEnv).S3_BUCKET_ARTIFACTS),
        },
        {
          provide: SITE_INTEL,
          inject: [APP_ENV, CLOCK, IntelClient],
          useFactory: (env: AppEnv, clock: Clock, intel: IntelClient): SiteIntelPort =>
            fakeSiteIntelEnabled(env as ApiEnv) ? new FakeSiteIntel(clock) : new IntelSiteIntel(intel),
        },
        { provide: RUN_PROGRESS, useClass: RealtimeEnrichmentProgress },
        { provide: RATE_LIMITER, useClass: ValkeyRateLimiter },
        // The worker reconciles and schedules; the HTTP process only produces jobs.
        { provide: MAINTENANCE_AUTOSTART, useValue: mode === 'worker' },
        IntelClient,
        StepRegistry,
        EnrichmentOrchestrator,
        EnrichmentPlanning,
        StartEnrichmentCommand,
        EstimateEnrichmentQuery,
        EnrichmentQueries,
        BulkEnrichCommand,
        AutoEnrichSubscriber,
        NightlyRefresh,
        EnrichmentReconciler,
        EnrichmentScheduler,
        ...(mode === 'worker'
          ? [EnrichmentRunProcessor, EnrichmentStepProcessor, EnrichmentRefreshProcessor]
          : []),
      ],
      exports: [StepRegistry, EnrichmentReconciler, EnrichmentScheduler],
    };
  }

  /** `site_intel` registers through the same registry later steps use. */
  onModuleInit(): void {
    const env = this.env as ApiEnv;
    this.registry.register(
      new SiteIntelStep({
        intel: this.siteIntel,
        snapshots: this.snapshots,
        media: this.media,
        markers: this.markers,
        ingest: this.ingest,
        clock: this.clock,
        ttlDays: env.ENRICHMENT_TTL_SITE_INTEL_DAYS,
        costUsd: env.ENRICHMENT_SITE_INTEL_COST_USD,
      }),
    );
  }
}
