import type {
  CategoryAttributes,
  EmailVerifierId,
  EnrichmentRunStatus,
  EnrichmentSkipReason,
  EnrichmentStepId,
  EnrichmentStepStatus,
  EnrichmentTrigger,
  Finding,
  PsiResult,
  PsiStrategy,
  PsiStrategyResult,
  SiteIntel,
  SMTP_PROBE_ERRORS,
  VisionGrade,
  WebsiteStatus,
} from '@bf/contracts';
import type { EmailCheck } from '../domain/email-verification.ts';
import type { EnrichmentSubject, StepOutput } from '../domain/enrichment-step.ts';

// Ports of the enrichment module (BF-027).

export interface RunRecord {
  readonly id: string;
  readonly businessId: string;
  readonly organizationId: string;
  readonly requestedBy: string | null;
  readonly trigger: EnrichmentTrigger;
  readonly requestedSteps: readonly EnrichmentStepId[];
  readonly force: boolean;
  readonly status: EnrichmentRunStatus;
  readonly estimatedUsd: number;
  readonly costUsd: number;
  readonly changedFields: readonly string[];
  readonly error: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface StepRecord {
  readonly id: string;
  readonly runId: string;
  readonly businessId: string;
  readonly step: EnrichmentStepId;
  readonly dependsOn: readonly EnrichmentStepId[];
  readonly status: EnrichmentStepStatus;
  readonly attempt: number;
  /** Times the step deferred itself (not attempts). */
  readonly deferrals: number;
  readonly inputHash: string | null;
  readonly outputRef: Readonly<Record<string, unknown>> | null;
  readonly estimatedUsd: number;
  readonly costUsd: number;
  readonly skipReason: EnrichmentSkipReason | null;
  readonly error: string | null;
  readonly heartbeatAt: Date | null;
  /** Waiting out a backoff or a rate limit until then (its delayed job exists). */
  readonly notBefore: Date | null;
  /** The job that claimed it (cancellation target). */
  readonly jobId: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly updatedAt: Date;
}

export interface NewRun {
  readonly businessId: string;
  readonly organizationId: string;
  readonly requestedBy: string | null;
  readonly trigger: EnrichmentTrigger;
  readonly requestedSteps: readonly EnrichmentStepId[];
  readonly force: boolean;
  readonly estimatedUsd: number;
  readonly idempotencyKey: string | null;
}

export interface NewStep {
  readonly step: EnrichmentStepId;
  readonly dependsOn: readonly EnrichmentStepId[];
  readonly status: 'queued' | 'skipped';
  readonly skipReason: EnrichmentSkipReason | null;
  readonly inputHash: string | null;
  readonly estimatedUsd: number;
}

export type StepCompletion =
  | {
      readonly status: 'done';
      readonly costUsd: number;
      readonly outputRef: Readonly<Record<string, unknown>>;
      readonly changedFields: readonly string[];
    }
  | { readonly status: 'skipped'; readonly reason: EnrichmentSkipReason; readonly costUsd: number }
  | { readonly status: 'failed'; readonly error: string; readonly costUsd: number };

export interface EnrichmentRepository {
  /**
   * Serializes run creation for a workspace (transaction-scoped lock): its monthly budget, open-run cap and "one
   * open run per business" are checked and reserved under it.
   */
  lockOrganization(organizationId: string): Promise<void>;
  /** Open (queued or running) runs of a workspace. */
  countOpenRuns(organizationId: string): Promise<number>;
  /** Inserts a run and its steps (call inside a transaction). */
  createRun(run: NewRun, steps: readonly NewStep[]): Promise<RunRecord>;
  findByIdempotencyKey(organizationId: string, key: string): Promise<RunRecord | undefined>;
  /** A queued or running run of this workspace for the business (one at a time). */
  findOpenRun(organizationId: string, businessId: string): Promise<RunRecord | undefined>;
  findRun(runId: string): Promise<RunRecord | undefined>;
  /** Locks the run row for the rest of the transaction (serializes step completions and finalization). */
  lockRun(runId: string): Promise<RunRecord | undefined>;
  latestRun(organizationId: string, businessId: string): Promise<RunRecord | undefined>;
  steps(runId: string): Promise<StepRecord[]>;
  findStep(stepRowId: string): Promise<StepRecord | undefined>;
  /** Latest `done` output per step for a business (freshness, dependencies), any workspace's run. */
  latestOutputs(businessId: string): Promise<Map<EnrichmentStepId, StepOutput>>;
  /** `latestOutputs` for many businesses in one query (estimates). */
  latestOutputsMany(businessIds: readonly string[]): Promise<Map<string, Map<EnrichmentStepId, StepOutput>>>;
  /** Estimated enrichment spend of a workspace this calendar month (UTC): costs of finished runs, estimates
   * of open ones. */
  /**
   * The workspace's enrichment spend this month: finished runs' costs plus open runs' estimates (or costs so far,
   * when higher); `actualOnly` counts only what was actually spent.
   */
  monthSpendUsd(
    organizationId: string,
    at: Date,
    options?: { readonly actualOnly?: boolean },
  ): Promise<number>;
  /** queued → running; false when the run is not queued. */
  markRunning(runId: string, at: Date): Promise<boolean>;
  /**
   * queued → running for the step (attempt + 1, heartbeat, the claiming job); undefined when it is not queued, is
   * waiting out a delay, or a dependency in its run is not terminal yet.
   */
  claimStep(stepRowId: string, at: Date, jobId: string): Promise<StepRecord | undefined>;
  /** A queued step waits until `until` (rate limit): the reconciler leaves it alone until then. */
  deferStep(stepRowId: string, until: Date): Promise<void>;
  heartbeat(stepRowId: string, at: Date): Promise<void>;
  /**
   * A running step back to queued: `notBefore` its retry (backoff); `refund` gives its attempt back (an open
   * circuit, a worker shutdown).
   */
  releaseStep(
    stepRowId: string,
    error: string | null,
    at: Date,
    options?: {
      readonly refund?: boolean;
      readonly notBefore?: Date;
      /** The step deferred itself: counted in `deferrals`. */
      readonly deferred?: boolean;
    },
  ): Promise<StepRecord | undefined>;
  /**
   * Books what an attempt spent and changed before it stopped (whatever the step's or run's status, so a cancelled
   * run still accounts for money already spent): adds to the step's and run's cost and the run's changed fields.
   */
  addSpend(stepRowId: string, costUsd: number, changedFields: readonly string[]): Promise<void>;
  /** running → terminal, adding its cost and changed fields to the run; false when it was not running. */
  completeStep(stepRowId: string, completion: StepCompletion, at: Date): Promise<boolean>;
  /** queued → skipped for these steps. */
  skipSteps(stepRowIds: readonly string[], reason: EnrichmentSkipReason, at: Date): Promise<void>;
  /** Open → terminal; false when already terminal. */
  finishRun(runId: string, status: EnrichmentRunStatus, at: Date, error?: string | null): Promise<boolean>;
  /** Steps of open runs whose worker stopped beating (running, heartbeat before `before`). */
  staleRunningSteps(before: Date, limit: number): Promise<StepRecord[]>;
  /**
   * Queued steps of running runs not touched since `before` and due (`not_before` passed) whose dependencies are all
   * terminal: their job may be lost.
   */
  idleQueuedSteps(before: Date, limit: number): Promise<StepRecord[]>;
  /** Open runs not touched since `before` (never started, or with every step terminal). */
  idleOpenRuns(before: Date, limit: number): Promise<RunRecord[]>;
  /** Runs a workspace started with this trigger since `since` (the nightly cap counts a retried day). */
  countRunsSince(organizationId: string, trigger: EnrichmentTrigger, since: Date): Promise<number>;
  /** Workspaces tracking at least one business (nightly refresh). */
  trackingOrganizations(): Promise<string[]>;
  /**
   * Businesses a workspace tracks, with no open run, for which some registered step has no output newer than its
   * `staleBefore` — least recently enriched (by this workspace) first. Whether a step applies is the planner's call.
   */
  refreshCandidates(
    organizationId: string,
    steps: readonly { readonly step: EnrichmentStepId; readonly staleBefore: Date }[],
    limit: number,
    /** An output whose `outputRef.recheckAt` is before this is stale too (inconclusive checks, BF-028). */
    now: Date,
  ): Promise<string[]>;
}
export const ENRICHMENT_REPOSITORY = Symbol('EnrichmentRepository');

export interface SubjectReader {
  /** The business as steps see it; undefined when it does not exist (or was merged away). */
  subject(businessId: string): Promise<EnrichmentSubject | undefined>;
  /** Whether the workspace tracks the business (it may only enrich what it tracks). */
  tracks(organizationId: string, businessId: string): Promise<boolean>;
  /** Subjects of those of `businessIds` the workspace tracks, in one pass (estimates). */
  trackedSubjects(organizationId: string, businessIds: readonly string[]): Promise<EnrichmentSubject[]>;
}
export const SUBJECT_READER = Symbol('EnrichmentSubjectReader');

export interface EnrichmentQueue {
  start(
    runId: string,
    organizationId: string,
    trigger: EnrichmentTrigger,
    attemptKey?: string,
  ): Promise<void>;
  /**
   * Enqueues a step's job, keyed `stepRowId:attempt` (repeated calls are one job); `retryKey` makes another job
   * for the same attempt (a rate-limit wait, an open circuit, the reconciler). Interactive runs go first
   * (priority by trigger): a large bulk or the nightly refresh never holds up "Enrich now".
   */
  step(
    step: Pick<StepRecord, 'id' | 'runId' | 'attempt'>,
    organizationId: string,
    trigger: EnrichmentTrigger,
    options?: { readonly delayMs?: number; readonly retryKey?: string },
  ): Promise<void>;
  /** Signals the jobs running these steps (the job ids recorded at claim). */
  cancel(steps: readonly Pick<StepRecord, 'id' | 'jobId'>[]): Promise<void>;
  refresh(day: string): Promise<void>;
}
export const ENRICHMENT_QUEUE = Symbol('EnrichmentQueue');

export interface RunProgress {
  /** Realtime progress to the workspace (a handful per run: each claim and completion, and the end). */
  publish(run: RunRecord, steps: readonly StepRecord[], final: boolean): Promise<void>;
}
export const RUN_PROGRESS = Symbol('EnrichmentRunProgress');

// Site intel (the step implemented here).

export interface SiteIntelPort {
  analyse(
    request: {
      readonly url: string;
      readonly artifactPrefix: string;
      readonly localesHint: readonly string[];
      readonly countryHint: string | null;
    },
    signal: AbortSignal,
  ): Promise<SiteIntel>;
}
export const SITE_INTEL = Symbol('SiteIntelPort');

/** What a snapshot keeps of a site-intel answer (the request echo and timing are not kept). */
export type StoredSiteIntel = Omit<SiteIntel, 'requestedUrl' | 'fetchedAt' | 'durationMs'>;

export interface WebsiteSnapshotRecord {
  readonly id: string;
  readonly businessId: string;
  readonly url: string;
  readonly fetchedAt: Date;
  readonly contentHash: string;
  readonly intel: StoredSiteIntel;
}

export interface WebsiteSnapshotRepository {
  insert(snapshot: {
    readonly businessId: string;
    readonly url: string;
    readonly runId: string;
    readonly contentHash: string;
    readonly intel: StoredSiteIntel & { readonly fetchedAt: string };
  }): Promise<WebsiteSnapshotRecord>;
  latest(businessId: string): Promise<WebsiteSnapshotRecord | undefined>;
  byId(id: string): Promise<WebsiteSnapshotRecord | undefined>;
}
export const WEBSITE_SNAPSHOTS = Symbol('WebsiteSnapshotRepository');

/** The sticky "do not solicit us" marker of a business (compliance; set by crawls, cleared only by a person). */
export interface NoSolicitationMarkers {
  /** Sets (or refreshes) the marker; a cleared one is set again. */
  record(
    businessId: string,
    evidence: {
      readonly pageUrl: string;
      readonly phrases: readonly string[];
      readonly snippet: string | null;
      readonly snapshotId: string;
    },
    at: Date,
  ): Promise<void>;
  active(businessId: string): Promise<boolean>;
  find(businessId: string): Promise<NoSolicitationMarker | undefined>;
}
export const NO_SOLICITATION_MARKERS = Symbol('NoSolicitationMarkers');

export interface NoSolicitationMarker {
  readonly firstDetectedAt: Date;
  readonly lastDetectedAt: Date;
  readonly pageUrl: string;
  readonly phrases: readonly string[];
  readonly snippet: string | null;
  readonly clearedAt: Date | null;
}

// E-mail verification (BF-028).

export type SmtpProbeError = (typeof SMTP_PROBE_ERRORS)[number];

/** One verifier of the chain (Adapter): Reacher, a commercial API, DNS. */
export interface EmailVerifier {
  readonly id: EmailVerifierId;
  /** Whether this deployment (and workspace: its key) can use it at all. */
  available(organizationId: string, context?: { readonly pendingUsd?: number }): Promise<boolean>;
  /** Checks one normalized address. Throws on failure (transient errors are typed `ExternalServiceError`). */
  verify(
    email: string,
    context: { readonly organizationId: string; readonly signal: AbortSignal },
  ): Promise<EmailCheck>;
}
export const EMAIL_VERIFIER_LIST = Symbol('EmailVerifierList');

export interface CachedVerdict {
  readonly check: EmailCheck;
  readonly checkedAt: Date;
  readonly expiresAt: Date;
  /** Consecutive inconclusive checks (backoff); 0 after a conclusive one. */
  readonly inconclusiveStreak: number;
}

/**
 * Verdicts by address, shared by every workspace: a mailbox is asked at most once per TTL. Implementations key by a
 * hash of the address (never stored in clear).
 */
export interface EmailVerdictCache {
  get(email: string): Promise<CachedVerdict | undefined>;
  /** Stores a verdict unless a newer one is already there. */
  put(email: string, verdict: CachedVerdict): Promise<void>;
  /** Deletes verdicts that expired before `before` (retention); returns how many. */
  purgeExpired(before: Date): Promise<number>;
}
export const EMAIL_VERDICT_CACHE = Symbol('EmailVerdictCache');

/**
 * Addresses that must not be checked (unsubscribed, objected): looked up before any verifier is called. No-op
 * until outreach suppression lists exist (BF-049).
 */
export interface EmailSuppressionCheck {
  isSuppressed(organizationId: string, email: string): Promise<boolean>;
}
export const EMAIL_SUPPRESSION = Symbol('EmailSuppressionCheck');

/**
 * Whether personal addresses may be contacted for this business (its jurisdiction and the workspace's choices):
 * pattern guessing only runs when they may. Deny-all until outreach compliance exists (BF-049).
 */
export interface PersonalAddressPolicy {
  allowsPersonalAddresses(organizationId: string, businessId: string): Promise<boolean>;
}
export const PERSONAL_ADDRESS_POLICY = Symbol('PersonalAddressPolicy');

/** Port 25 towards a large mail provider's MX (Settings → Integrations diagnostic). */
export interface SmtpPortProbe {
  probe(signal: AbortSignal): Promise<{
    readonly reachable: boolean;
    readonly host: string | null;
    readonly latencyMs: number | null;
    readonly error: SmtpProbeError | null;
  }>;
}
export const SMTP_PORT_PROBE = Symbol('SmtpPortProbe');

// ---------------------------------------------------------------------------------------------------------------
// Website audit (BF-030)

/** One PageSpeed Insights run (`runPagespeed`, all four categories) for a strategy. */
export interface PageSpeedPort {
  run(
    url: string,
    strategy: PsiStrategy,
    options: { readonly key: string | undefined; readonly signal: AbortSignal },
  ): Promise<PsiStrategyResult>;
}
export const PAGESPEED = Symbol('PageSpeedPort');

/** Grades a snapshot's screenshots (null when it has none to grade). */
export interface VisionGrader {
  grade(
    organizationId: string,
    snapshot: WebsiteSnapshotRecord,
    subject: { readonly displayName: string; readonly categoryLabel: string | null },
    signal: AbortSignal,
  ): Promise<{ readonly grade: VisionGrade; readonly costUsd: number } | null>;
}
export const VISION_GRADER = Symbol('VisionGrader');

/** What the audit rules need to know about the business (primary category, country). */
export interface AuditBusinessFacts {
  readonly countryCode: string | null;
  readonly categoryAttributes: CategoryAttributes;
  readonly servesFood: boolean;
  readonly categoryLabel: string | null;
}

export interface WebsiteAuditRecord {
  readonly id: string;
  readonly businessId: string;
  readonly snapshotId: string;
  readonly psi: PsiResult | null;
  readonly vision: VisionGrade | null;
  readonly findings: Finding[];
  readonly qualityScore: number | null;
  readonly websiteStatus: WebsiteStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WebsiteAuditRepository {
  /** The snapshot's audit, locked until the transaction ends (created empty first if missing). */
  lockForSnapshot(businessId: string, snapshotId: string): Promise<WebsiteAuditRecord | undefined>;
  save(audit: Omit<WebsiteAuditRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<WebsiteAuditRecord>;
  latest(businessId: string): Promise<WebsiteAuditRecord | undefined>;
  businessFacts(businessId: string): Promise<AuditBusinessFacts>;
}
export const WEBSITE_AUDITS = Symbol('WebsiteAuditRepository');
