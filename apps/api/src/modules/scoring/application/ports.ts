import type { FeatureVector, Offer, ScoreResult, ScoreTier, ScoringProfileConfig } from '@bf/contracts';
import type { BusinessFacts } from '../domain/facts.ts';

// Ports of the scoring module (BF-031).

export interface ProfileRecord {
  readonly id: string;
  readonly organizationId: string | null;
  readonly offer: Offer;
  readonly name: string;
  readonly builtin: boolean;
  readonly activeVersion: number | null;
}

export interface ProfileVersionRecord {
  readonly profileId: string;
  readonly version: number;
  readonly config: ScoringProfileConfig;
  readonly createdAt: Date;
}

/** A profile with the config of its active version (what scores are computed with). */
export interface ActiveProfile extends ProfileRecord {
  readonly activeVersion: number;
  readonly config: ScoringProfileConfig;
}

export interface ScoreWrite extends ScoreResult {
  readonly organizationId: string;
  readonly businessId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly features: FeatureVector;
  readonly featureSetVersion: number;
  readonly factsHash: string;
  readonly computedAt: Date;
}

/** A write and whether it is new history (a forced recompute of an unchanged vector rewrites only the current row). */
export interface ScoreWriteRequest extends ScoreWrite {
  readonly history: boolean;
}

export interface StoredScore extends ScoreWrite {}

/** What a batch write changed: the scores that moved (for `score.updated`). */
export interface ScoreChange {
  readonly write: ScoreWrite;
  readonly previous: { readonly score: number; readonly tier: ScoreTier } | null;
}

export interface ScoringRepository {
  /** Built-in profiles and the workspace's own, with their active version's config. */
  activeProfiles(organizationId: string): Promise<ActiveProfile[]>;
  profiles(organizationId: string): Promise<ProfileRecord[]>;
  /** A profile the workspace may see (built-in or its own). */
  profile(organizationId: string, profileId: string): Promise<ProfileRecord | undefined>;
  version(profileId: string, version: number): Promise<ProfileVersionRecord | undefined>;
  /** Creates the built-in profiles and versions that do not exist yet (idempotent); returns the ones it activated. */
  ensureBuiltins(
    profiles: readonly {
      id: string;
      offer: Offer;
      name: string;
      version: number;
      config: ScoringProfileConfig;
    }[],
  ): Promise<{ readonly profileId: string; readonly version: number }[]>;
  /** Workspaces tracking at least one business (a new built-in version recomputes them). */
  workspacesWithBusinesses(): Promise<string[]>;
  /** The workspace's primary profile id (null: the default built-in). */
  primaryProfileId(organizationId: string): Promise<string | null>;
  setPrimaryProfile(organizationId: string, profileId: string, userId: string | null): Promise<void>;
  /** Serializes score writes per business of the workspace (transaction-scoped advisory locks, in id order). */
  lockBusinesses(organizationId: string, businessIds: readonly string[]): Promise<void>;
  /** The current scores of these businesses (fingerprints to skip unchanged writes). */
  currentScores(
    organizationId: string,
    businessIds: readonly string[],
  ): Promise<
    Map<
      string,
      {
        profileId: string;
        profileVersion: number;
        featureSetVersion: number;
        factsHash: string;
        score: number;
        tier: ScoreTier;
        computedAt: Date;
      }[]
    >
  >;
  /**
   * Upserts current scores, appends history and, for the primary profile, refreshes `org_businesses.score/tier`
   * (one transaction per batch).
   */
  writeScores(writes: readonly ScoreWriteRequest[], primaryProfileId: string): Promise<void>;
  /** Copies the primary profile's current scores into `org_businesses` (null where it has none). */
  denormalizePrimary(organizationId: string, primaryProfileId: string): Promise<void>;
  businessScores(organizationId: string, businessId: string): Promise<StoredScore[]>;
  tracks(organizationId: string, businessId: string): Promise<boolean>;
  /** Businesses a discovery run added to the workspace. */
  trackedByRun(organizationId: string, runId: string): Promise<string[]>;
  /** Tracked businesses of a workspace, in id order after `after` (bulk recompute pages). */
  trackedPage(organizationId: string, after: string | null, limit: number): Promise<string[]>;
  trackedCount(organizationId: string): Promise<number>;
  /** Workspaces tracking these businesses (global events fan out to them). */
  workspacesTracking(businessIds: readonly string[]): Promise<Map<string, string[]>>;
}
export const SCORING_REPOSITORY = Symbol('ScoringRepository');

/** Builds the facts of many businesses of one workspace in a few bulk queries (no N+1). */
export interface FactsAssembler {
  assemble(organizationId: string, businessIds: readonly string[], asOf: Date): Promise<BusinessFacts[]>;
}
export const FACTS_ASSEMBLER = Symbol('FactsAssembler');

export interface ScoringQueue {
  compute(input: {
    readonly organizationId: string;
    readonly businessIds: readonly string[];
    readonly idempotencyKey: string;
    readonly profileIds?: readonly string[];
  }): Promise<void>;
  recompute(input: {
    readonly organizationId: string;
    readonly profileId: string;
    readonly version: number;
    readonly idempotencyKey: string;
    readonly requestedBy?: string;
  }): Promise<void>;
}
export const SCORING_QUEUE = Symbol('ScoringQueue');

export interface RecomputeProgress {
  progressed(
    organizationId: string,
    progress: { profileId: string; version: number; done: number; total: number },
  ): Promise<void>;
  finished(
    organizationId: string,
    progress: { profileId: string; version: number; done: number; total: number },
  ): Promise<void>;
}
export const RECOMPUTE_PROGRESS = Symbol('RecomputeProgress');
