import type { AiGateway } from '@bf/ai';
import type { ApiEnv } from '@bf/config';
import type { Clock } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { type DynamicModule, Inject, Module, type OnModuleInit } from '@nestjs/common';
import {
  BusinessGraphModule,
  EmailContactsQuery,
  IngestSourceRecordCommand,
  RecordEmailVerificationCommand,
  ReplaceWebsiteMediaCommand,
} from '../business-graph/index.ts';
import { AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { CLOCK } from '../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { IntelClient } from '../platform/intel/intel-client.ts';
import { LOGGER } from '../platform/logging/logger.ts';
import {
  RATE_LIMITER,
  type RateLimiter,
  ValkeyRateLimiter,
} from '../platform/rate-limit/valkey-rate-limiter.ts';
import type { ObjectStorage } from '../platform/storage/object-storage.ts';
import { ARTIFACT_STORAGE, InMemoryObjectStorage } from '../platform/storage/object-storage.ts';
import { S3ObjectStorage } from '../platform/storage/s3-object-storage.ts';
import { RealtimeModule } from '../realtime/index.ts';
import { ConnectionTesterRegistry, FeatureFlagService, SecretResolver } from '../workspace/index.ts';
import { EmailVerificationService } from './application/email-verification.service.ts';
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
  EMAIL_SUPPRESSION,
  EMAIL_VERDICT_CACHE,
  EMAIL_VERIFIER_LIST,
  type EmailSuppressionCheck,
  type EmailVerdictCache,
  type EmailVerifier,
  ENRICHMENT_QUEUE,
  ENRICHMENT_REPOSITORY,
  type EnrichmentQueue,
  NO_SOLICITATION_MARKERS,
  type NoSolicitationMarkers,
  PAGESPEED,
  type PageSpeedPort,
  PERSONAL_ADDRESS_POLICY,
  type PersonalAddressPolicy,
  RUN_PROGRESS,
  SITE_INTEL,
  type SiteIntelPort,
  SMTP_PORT_PROBE,
  SUBJECT_READER,
  VISION_GRADER,
  type VisionGrader,
  WEBSITE_AUDITS,
  WEBSITE_SNAPSHOTS,
  type WebsiteSnapshotRepository,
} from './application/ports.ts';
import { EnrichmentOrchestrator } from './application/run-orchestrator.ts';
import { NightlyMaintenance, StepRegistry } from './application/step-registry.ts';
import { VerifyContactCommand } from './application/verify-contact.command.ts';
import { WebsiteAuditService } from './application/website-audit.service.ts';
import { BullmqEnrichmentQueue } from './infrastructure/bullmq-enrichment-queue.ts';
import {
  DrizzleEmailVerdictCache,
  NoPersonalAddresses,
  NoSuppression,
} from './infrastructure/drizzle-email-verification.ts';
import { DrizzleEnrichmentRepository } from './infrastructure/drizzle-enrichment.repository.ts';
import { DrizzleSubjectReader } from './infrastructure/drizzle-subject-reader.ts';
import {
  DrizzleNoSolicitationMarkers,
  DrizzleWebsiteSnapshotRepository,
} from './infrastructure/drizzle-website.repository.ts';
import { DrizzleWebsiteAuditRepository } from './infrastructure/drizzle-website-audits.ts';
import {
  DnsMxVerifier,
  dnsResolver,
  FAKE_MAIL_DNS,
  FakeEmailVerifier,
  PoliteMailServerVerifier,
  ReacherVerifier,
  ZeroBounceVerifier,
} from './infrastructure/email-verifiers.ts';
import {
  EnrichmentReconciler,
  EnrichmentScheduler,
  MAINTENANCE_AUTOSTART,
} from './infrastructure/enrichment-maintenance.ts';
import { FakePageSpeed, PageSpeedClient } from './infrastructure/pagespeed.ts';
import { RealtimeEnrichmentProgress } from './infrastructure/realtime-run-progress.ts';
import { FakeSiteIntel, IntelSiteIntel } from './infrastructure/site-intel.adapters.ts';
import { FakeSmtpPortProbe, TcpSmtpPortProbe } from './infrastructure/smtp-port-probe.ts';
import { EmailVerifyStep } from './infrastructure/steps/email-verify.step.ts';
import { SiteIntelStep } from './infrastructure/steps/site-intel.step.ts';
import { PsiStep, VisionAuditStep } from './infrastructure/steps/website-audit.steps.ts';
import { FakeVisionGrader, LlmVisionGrader } from './infrastructure/vision-graders.ts';
import { EmailVerificationController } from './interface/http/email-verification.controller.ts';
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

/** The fake PageSpeed and vision grader exist only in tests and E2E (refused in production). */
function fakeWebsiteAuditEnabled(env: ApiEnv): boolean {
  if (!env.FAKE_WEBSITE_AUDIT) return false;
  if (env.NODE_ENV === 'production') throw new Error('FAKE_WEBSITE_AUDIT is refused in production');
  return true;
}

/** The fake e-mail verifier and port probe exist only in tests and E2E (refused in production). */
function fakeEmailVerifierEnabled(env: ApiEnv): boolean {
  if (!env.FAKE_EMAIL_VERIFIER) return false;
  if (env.NODE_ENV === 'production') throw new Error('FAKE_EMAIL_VERIFIER is refused in production');
  return true;
}

/**
 * The verifier chain's links this deployment has (the workspace picks their order). Reacher talks to recipients'
 * mail servers: always behind the politeness decorator (public mail hosts only, a token per mail server).
 */
function emailVerifiers(
  env: ApiEnv,
  secrets: SecretResolver,
  limiter: RateLimiter,
  planning: EnrichmentPlanning,
): EmailVerifier[] {
  if (fakeEmailVerifierEnabled(env)) return [new FakeEmailVerifier(), new DnsMxVerifier(FAKE_MAIL_DNS)];
  const dns = dnsResolver();
  return [
    new PoliteMailServerVerifier(
      new ReacherVerifier(env.REACHER_URL, env.EMAIL_VERIFY_CONCURRENCY, env.REACHER_HEADER_SECRET),
      { dns, limiter, perMinute: env.EMAIL_VERIFY_PER_MAIL_SERVER_PER_MINUTE },
    ),
    new ZeroBounceVerifier(
      (organizationId) => secrets.resolve(organizationId, 'zerobounce'),
      env.ENRICHMENT_EMAIL_VERIFY_COST_USD,
      (organizationId, usd) => planning.canSpend(organizationId, usd),
    ),
    new DnsMxVerifier(dns),
  ];
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
    private readonly emailVerification: EmailVerificationService,
    private readonly emailContacts: EmailContactsQuery,
    private readonly recordVerification: RecordEmailVerificationCommand,
    private readonly flags: FeatureFlagService,
    private readonly testers: ConnectionTesterRegistry,
    @Inject(EMAIL_SUPPRESSION) private readonly suppression: EmailSuppressionCheck,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(PERSONAL_ADDRESS_POLICY) private readonly personalAddresses: PersonalAddressPolicy,
    @Inject(PAGESPEED) private readonly pagespeed: PageSpeedPort,
    @Inject(VISION_GRADER) private readonly visionGrader: VisionGrader,
    private readonly websiteAudits: WebsiteAuditService,
    private readonly secrets: SecretResolver,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  private static readonly byMode = new Map<AppMode, DynamicModule>();

  /** One definition per mode: modules importing this one (reviews, BF-029) share the app module's instance. */
  static forRoot(mode: AppMode): DynamicModule {
    let definition = EnrichmentModule.byMode.get(mode);
    if (!definition) {
      definition = EnrichmentModule.build(mode);
      EnrichmentModule.byMode.set(mode, definition);
    }
    return definition;
  }

  private static build(mode: AppMode): DynamicModule {
    return {
      module: EnrichmentModule,
      imports: [BusinessGraphModule.forRoot(mode), RealtimeModule.forRoot(mode)],
      controllers:
        mode === 'worker'
          ? []
          : [BusinessEnrichmentController, EnrichmentController, EmailVerificationController],
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
        {
          provide: EMAIL_VERIFIER_LIST,
          inject: [APP_ENV, SecretResolver, RATE_LIMITER, EnrichmentPlanning],
          useFactory: (
            env: AppEnv,
            secrets: SecretResolver,
            limiter: RateLimiter,
            planning: EnrichmentPlanning,
          ) => emailVerifiers(env as ApiEnv, secrets, limiter, planning),
        },
        { provide: EMAIL_VERDICT_CACHE, useClass: DrizzleEmailVerdictCache },
        // DECISION(BF-028): no suppression lists and no personal-address policy before BF-049 (deny-all).
        { provide: EMAIL_SUPPRESSION, useClass: NoSuppression },
        { provide: PERSONAL_ADDRESS_POLICY, useClass: NoPersonalAddresses },
        {
          provide: SMTP_PORT_PROBE,
          inject: [APP_ENV, CLOCK],
          useFactory: (env: AppEnv, clock: Clock) =>
            fakeEmailVerifierEnabled(env as ApiEnv) ? new FakeSmtpPortProbe() : new TcpSmtpPortProbe(clock),
        },
        EmailVerificationService,
        VerifyContactCommand,
        { provide: WEBSITE_AUDITS, useClass: DrizzleWebsiteAuditRepository },
        WebsiteAuditService,
        {
          provide: PAGESPEED,
          inject: [APP_ENV, CLOCK],
          useFactory: (env: AppEnv, clock: Clock): PageSpeedPort =>
            fakeWebsiteAuditEnabled(env as ApiEnv) ? new FakePageSpeed(clock) : new PageSpeedClient(clock),
        },
        {
          provide: VISION_GRADER,
          inject: [APP_ENV, AI_GATEWAY, ARTIFACT_STORAGE, CLOCK, LOGGER],
          useFactory: (
            env: AppEnv,
            gateway: AiGateway,
            artifacts: ObjectStorage,
            clock: Clock,
            logger: Logger,
          ): VisionGrader =>
            fakeWebsiteAuditEnabled(env as ApiEnv)
              ? new FakeVisionGrader(clock)
              : new LlmVisionGrader(gateway, artifacts, clock, (count) =>
                  logger.warn({ count }, 'vision grade reported instructions inside screenshots'),
                ),
        },
        { provide: RATE_LIMITER, useClass: ValkeyRateLimiter },
        // The worker reconciles and schedules; the HTTP process only produces jobs.
        { provide: MAINTENANCE_AUTOSTART, useValue: mode === 'worker' },
        IntelClient,
        StepRegistry,
        NightlyMaintenance,
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
      exports: [
        StepRegistry,
        NightlyMaintenance,
        EnrichmentPlanning,
        EnrichmentReconciler,
        EnrichmentScheduler,
      ],
    };
  }

  /** `site_intel` and `email_verify` register through the same registry later steps use. */
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
    this.registry.register(
      new EmailVerifyStep({
        contacts: this.emailContacts,
        verification: this.emailVerification,
        record: this.recordVerification,
        patternGuessing: (organizationId) => this.flags.isEnabled(organizationId, 'emailPatternGuessing'),
        personalAddresses: this.personalAddresses,
        clock: this.clock,
        ttlDays: env.ENRICHMENT_TTL_EMAIL_VERIFY_DAYS,
        unitCostUsd: env.ENRICHMENT_EMAIL_VERIFY_COST_USD,
      }),
    );
    this.registry.register(
      new PsiStep({
        snapshots: this.snapshots,
        pagespeed: this.pagespeed,
        audits: this.websiteAudits,
        key: async (organizationId) => (await this.secrets.resolve(organizationId, 'pagespeed'))?.value,
        limiter: this.limiter,
        quota: { perMinute: env.PAGESPEED_RATE_PER_MINUTE, perDay: env.PAGESPEED_DAILY_QUOTA },
        clock: this.clock,
        logger: this.logger,
        ttlDays: env.ENRICHMENT_TTL_PSI_DAYS,
      }),
    );
    this.registry.register(
      new VisionAuditStep({
        snapshots: this.snapshots,
        grader: this.visionGrader,
        audits: this.websiteAudits,
        clock: this.clock,
        logger: this.logger,
        ttlDays: env.ENRICHMENT_TTL_VISION_AUDIT_DAYS,
        costUsd: env.ENRICHMENT_VISION_AUDIT_COST_USD,
      }),
    );
    if (env.NODE_ENV === 'production' && this.suppression instanceof NoSuppression) {
      this.logger.warn('e-mail verification runs without suppression lists (bound by BF-049)');
    }
    if (!this.testers.has('zerobounce')) {
      this.testers.register('zerobounce', async ({ value, signal }) => {
        try {
          return await ZeroBounceVerifier.testKey(value, signal);
        } catch {
          return { ok: false, message: 'The connection test failed.' };
        }
      });
    }
  }
}
