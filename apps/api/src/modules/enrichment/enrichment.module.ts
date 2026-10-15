import type { ApiEnv } from '@bf/config';
import type { Clock } from '@bf/contracts';
import { type DynamicModule, Inject, Module, type OnModuleInit } from '@nestjs/common';
import {
  BusinessGraphModule,
  IngestSourceRecordCommand,
  RecordEmailVerificationCommand,
  ReplaceWebsiteMediaCommand,
} from '../business-graph/index.ts';
import { CLOCK } from '../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { IntelClient } from '../platform/intel/intel-client.ts';
import { RATE_LIMITER, ValkeyRateLimiter } from '../platform/rate-limit/valkey-rate-limiter.ts';
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
  EMAIL_CONTACT_READER,
  EMAIL_SUPPRESSION,
  EMAIL_VERDICT_CACHE,
  EMAIL_VERIFIER_LIST,
  type EmailContactReader,
  type EmailVerifier,
  ENRICHMENT_QUEUE,
  ENRICHMENT_REPOSITORY,
  type EnrichmentQueue,
  NO_SOLICITATION_MARKERS,
  type NoSolicitationMarkers,
  RUN_PROGRESS,
  SITE_INTEL,
  type SiteIntelPort,
  SMTP_PORT_PROBE,
  SUBJECT_READER,
  WEBSITE_SNAPSHOTS,
  type WebsiteSnapshotRepository,
} from './application/ports.ts';
import { EnrichmentOrchestrator } from './application/run-orchestrator.ts';
import { StepRegistry } from './application/step-registry.ts';
import { VerifyContactCommand } from './application/verify-contact.command.ts';
import { BullmqEnrichmentQueue } from './infrastructure/bullmq-enrichment-queue.ts';
import {
  DrizzleEmailContactReader,
  DrizzleEmailVerdictCache,
  NoSuppression,
} from './infrastructure/drizzle-email-verification.ts';
import { DrizzleEnrichmentRepository } from './infrastructure/drizzle-enrichment.repository.ts';
import { DrizzleSubjectReader } from './infrastructure/drizzle-subject-reader.ts';
import {
  DrizzleNoSolicitationMarkers,
  DrizzleWebsiteSnapshotRepository,
} from './infrastructure/drizzle-website.repository.ts';
import {
  DnsMxVerifier,
  FakeEmailVerifier,
  ReacherVerifier,
  ZeroBounceVerifier,
} from './infrastructure/email-verifiers.ts';
import {
  EnrichmentReconciler,
  EnrichmentScheduler,
  MAINTENANCE_AUTOSTART,
} from './infrastructure/enrichment-maintenance.ts';
import { RealtimeEnrichmentProgress } from './infrastructure/realtime-run-progress.ts';
import { FakeSiteIntel, IntelSiteIntel } from './infrastructure/site-intel.adapters.ts';
import { FakeSmtpPortProbe, TcpSmtpPortProbe } from './infrastructure/smtp-port-probe.ts';
import { EmailVerifyStep } from './infrastructure/steps/email-verify.step.ts';
import { SiteIntelStep } from './infrastructure/steps/site-intel.step.ts';
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

/** The fake e-mail verifier and port probe exist only in tests and E2E (refused in production). */
function fakeEmailVerifierEnabled(env: ApiEnv): boolean {
  if (!env.FAKE_EMAIL_VERIFIER) return false;
  if (env.NODE_ENV === 'production') throw new Error('FAKE_EMAIL_VERIFIER is refused in production');
  return true;
}

/** The verifier chain's links this deployment has (the workspace picks their order). */
function emailVerifiers(env: ApiEnv, secrets: SecretResolver): EmailVerifier[] {
  if (fakeEmailVerifierEnabled(env)) return [new FakeEmailVerifier(), new DnsMxVerifier()];
  return [
    new ReacherVerifier(env.REACHER_URL, env.EMAIL_VERIFY_CONCURRENCY),
    new ZeroBounceVerifier(
      (organizationId) => secrets.resolve(organizationId, 'zerobounce'),
      env.ENRICHMENT_EMAIL_VERIFY_COST_USD,
    ),
    new DnsMxVerifier(),
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
    @Inject(EMAIL_CONTACT_READER) private readonly emailContacts: EmailContactReader,
    private readonly recordVerification: RecordEmailVerificationCommand,
    private readonly flags: FeatureFlagService,
    private readonly testers: ConnectionTesterRegistry,
  ) {}

  static forRoot(mode: AppMode): DynamicModule {
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
          inject: [APP_ENV, SecretResolver],
          useFactory: (env: AppEnv, secrets: SecretResolver) => emailVerifiers(env as ApiEnv, secrets),
        },
        { provide: EMAIL_VERDICT_CACHE, useClass: DrizzleEmailVerdictCache },
        { provide: EMAIL_CONTACT_READER, useClass: DrizzleEmailContactReader },
        // DECISION(BF-028): no suppression lists before BF-049; the port is checked before every verification.
        { provide: EMAIL_SUPPRESSION, useClass: NoSuppression },
        {
          provide: SMTP_PORT_PROBE,
          inject: [APP_ENV, CLOCK],
          useFactory: (env: AppEnv, clock: Clock) =>
            fakeEmailVerifierEnabled(env as ApiEnv) ? new FakeSmtpPortProbe() : new TcpSmtpPortProbe(clock),
        },
        EmailVerificationService,
        VerifyContactCommand,
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
        clock: this.clock,
        ttlDays: env.ENRICHMENT_TTL_EMAIL_VERIFY_DAYS,
        unitCostUsd: env.ENRICHMENT_EMAIL_VERIFY_COST_USD,
      }),
    );
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
