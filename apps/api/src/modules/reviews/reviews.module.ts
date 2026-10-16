import type { AiGateway } from '@bf/ai';
import type { ApiEnv } from '@bf/config';
import type { Clock } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { type DynamicModule, Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DiscoveryModule, ScraperAcknowledgement } from '../discovery/index.ts';
import {
  EnrichmentModule,
  EnrichmentPlanning,
  NightlyMaintenance,
  StepRegistry,
} from '../enrichment/index.ts';
import { AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { CLOCK } from '../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { LOGGER } from '../platform/logging/logger.ts';
import { VALKEY } from '../platform/valkey/valkey.module.ts';
import { SecretResolver } from '../workspace/index.ts';
import {
  RATING_OBSERVATIONS,
  REVIEW_CLASSIFICATION_CACHE,
  REVIEW_CLASSIFIER,
  REVIEW_INSIGHTS,
  REVIEW_SOURCE_ADAPTERS,
  REVIEW_SOURCE_SETTINGS,
  REVIEW_SUBJECTS,
  type ReviewClassificationCache,
  type ReviewSourceAdapter,
  type ReviewSubjectReader,
  SCRAPER_GATE,
} from './application/ports.ts';
import { ReviewGates } from './application/review-gates.ts';
import { AnalyzePastedReviewsCommand, ReviewInsightsQuery } from './application/review-insights.use-cases.ts';
import { ReviewMiningService } from './application/review-mining.service.ts';
import {
  DrizzleRatingObservations,
  DrizzleReviewInsightsRepository,
  DrizzleReviewSourceSettings,
  DrizzleReviewSubjectReader,
} from './infrastructure/drizzle-reviews.repository.ts';
import {
  FakeReviewClassifier,
  LlmReviewClassifier,
  ValkeyReviewClassificationCache,
} from './infrastructure/review-classifiers.ts';
import { FakeReviewSource } from './infrastructure/sources/fake-review-sources.ts';
import { GooglePlacesReviewsSource } from './infrastructure/sources/google-places-reviews.source.ts';
import { ScraperReviewsSource } from './infrastructure/sources/scraper-reviews.source.ts';
import { ReviewsStep } from './infrastructure/steps/reviews.step.ts';
import { BusinessReviewsController, ReviewSourcesController } from './interface/http/reviews.controller.ts';

/** The fake review sources and classifier exist only in tests and E2E (refused in production). */
function fakeReviewsEnabled(env: ApiEnv): boolean {
  if (!env.FAKE_REVIEWS) return false;
  if (env.NODE_ENV === 'production') throw new Error('FAKE_REVIEWS is refused in production');
  return true;
}

/** Sources this deployment can fetch from, asynchronous ones first (see `ReviewsStep`). */
function reviewSources(
  env: ApiEnv,
  clock: Clock,
  secrets: SecretResolver,
  valkey: Redis,
): ReviewSourceAdapter[] {
  if (fakeReviewsEnabled(env)) {
    return [
      new FakeReviewSource('gmaps_scraper', clock),
      new FakeReviewSource('google_places', clock, env.ENRICHMENT_REVIEWS_GOOGLE_COST_USD),
    ];
  }
  const google = new GooglePlacesReviewsSource({
    clock,
    key: async (organizationId) => (await secrets.resolve(organizationId, 'google_places'))?.value,
    costUsd: env.ENRICHMENT_REVIEWS_GOOGLE_COST_USD,
  });
  if (!(env.FEATURE_MAPS_SCRAPER && env.MAPS_SCRAPER_URL)) return [google];
  return [
    new ScraperReviewsSource({
      clock,
      baseUrl: env.MAPS_SCRAPER_URL,
      maxTimeSeconds: env.MAPS_SCRAPER_MAX_TIME_SECONDS,
      valkey,
    }),
    google,
  ];
}

/**
 * Review mining (BF-029): licensing gates per workspace and source, the `reviews` enrichment step (registered with
 * BF-027's registry), manual analysis of pasted reviews, insights read side, and the nightly retention purge.
 */
@Module({})
export class ReviewsModule implements OnModuleInit {
  constructor(
    private readonly registry: StepRegistry,
    private readonly maintenance: NightlyMaintenance,
    private readonly planning: EnrichmentPlanning,
    private readonly gates: ReviewGates,
    private readonly mining: ReviewMiningService,
    @Inject(REVIEW_SUBJECTS) private readonly subjects: ReviewSubjectReader,
    @Inject(REVIEW_SOURCE_ADAPTERS) private readonly adapters: ReviewSourceAdapter[],
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: ReviewsModule,
      imports: [EnrichmentModule.forRoot(mode), DiscoveryModule.forRoot(mode)],
      controllers: mode === 'worker' ? [] : [BusinessReviewsController, ReviewSourcesController],
      providers: [
        { provide: REVIEW_INSIGHTS, useClass: DrizzleReviewInsightsRepository },
        { provide: RATING_OBSERVATIONS, useClass: DrizzleRatingObservations },
        { provide: REVIEW_SOURCE_SETTINGS, useClass: DrizzleReviewSourceSettings },
        { provide: REVIEW_SUBJECTS, useClass: DrizzleReviewSubjectReader },
        {
          provide: SCRAPER_GATE,
          inject: [ScraperAcknowledgement, APP_ENV],
          useFactory: (scraper: ScraperAcknowledgement, env: AppEnv) => ({
            allowed: async (organizationId: string) => {
              const apiEnv = env as ApiEnv;
              return (
                Boolean(apiEnv.FEATURE_MAPS_SCRAPER && apiEnv.MAPS_SCRAPER_URL) &&
                scraper.allowed(organizationId)
              );
            },
          }),
        },
        {
          provide: REVIEW_CLASSIFICATION_CACHE,
          inject: [VALKEY],
          useFactory: (valkey: Redis) => new ValkeyReviewClassificationCache(valkey),
        },
        {
          provide: REVIEW_CLASSIFIER,
          inject: [APP_ENV, AI_GATEWAY, REVIEW_CLASSIFICATION_CACHE],
          useFactory: (env: AppEnv, gateway: AiGateway, cache: ReviewClassificationCache) =>
            fakeReviewsEnabled(env as ApiEnv)
              ? new FakeReviewClassifier()
              : new LlmReviewClassifier(gateway, cache),
        },
        {
          provide: REVIEW_SOURCE_ADAPTERS,
          inject: [APP_ENV, CLOCK, SecretResolver, VALKEY],
          useFactory: (env: AppEnv, clock: Clock, secrets: SecretResolver, valkey: Redis) =>
            reviewSources(env as ApiEnv, clock, secrets, valkey),
        },
        ReviewMiningService,
        ReviewGates,
        ReviewInsightsQuery,
        AnalyzePastedReviewsCommand,
      ],
    };
  }

  /** `reviews` joins the enrichment registry; expired insights are purged with the nightly refresh. */
  onModuleInit(): void {
    const env = this.env as ApiEnv;
    this.registry.register(
      new ReviewsStep({
        gates: this.gates,
        subjects: this.subjects,
        mining: this.mining,
        adapters: this.adapters,
        canSpend: (organizationId, usd) => this.planning.canSpend(organizationId, usd),
        clock: this.clock,
        logger: this.logger,
        ttlDays: env.ENRICHMENT_TTL_REVIEWS_DAYS,
        llmCostUsd: env.ENRICHMENT_REVIEWS_LLM_COST_USD,
      }),
    );
    this.maintenance.register('review_insights_retention', (now) => this.mining.purgeExpired(now));
  }
}
