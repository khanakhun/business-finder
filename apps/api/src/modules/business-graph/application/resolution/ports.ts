import type { ContactType, MatchScore } from '@bf/contracts';
import type { CandidateProfile } from '../../domain/resolution/match-scorer.ts';
import type { NormalizedSource } from '../../domain/resolution/normalized-source.ts';

// Ports of entity resolution (BF-016). Adapters call getExecutor(db): everything runs in the ingestion transaction.

export interface LinkedSource {
  readonly id: string;
  readonly businessId: string | null;
  readonly contentHash: string;
  readonly normalized: NormalizedSource | null;
}

export interface ResolutionRepository {
  /** Transaction-scoped advisory locks on `keys` (already sorted), held until commit. */
  lockKeys(keys: readonly string[]): Promise<void>;
  /** Live (not merged) businesses sharing a blocking key with `source`, at most `limit`. */
  findCandidateIds(source: NormalizedSource, limit: number): Promise<string[]>;
  loadProfiles(businessIds: readonly string[]): Promise<CandidateProfile[]>;
  findSource(provider: string, providerRef: string): Promise<LinkedSource | undefined>;
  linkSource(
    sourceId: string,
    businessId: string,
    matchConfidence: number,
    linkedBy: 'auto' | 'manual',
  ): Promise<void>;
  /** Normalized views of every source linked to the business (legacy sources without one are skipped). */
  listLinkedSources(
    businessId: string,
  ): Promise<Array<{ readonly id: string; readonly normalized: NormalizedSource }>>;
  touchSource(sourceId: string, fetchedAt: Date, expiresAt: Date | null): Promise<void>;
  /** Returns whether the stored hours changed. */
  replaceHours(
    businessId: string,
    hours: ReadonlyArray<{ readonly weekday: number; readonly opensAt: string; readonly closesAt: string }>,
    source: string,
  ): Promise<boolean>;
  /** Returns whether the stored categories changed. */
  replaceCategories(
    businessId: string,
    categories: ReadonlyArray<{
      readonly categoryId: string;
      readonly isPrimary: boolean;
      readonly confidence: number;
      readonly source: string;
    }>,
  ): Promise<boolean>;
  /** Removes contacts that came from sources (not `manual`) and are no longer backed by any; returns how many. */
  deleteDerivedContactsExcept(
    businessId: string,
    keep: ReadonlyArray<{ readonly type: ContactType; readonly normalizedValue: string }>,
  ): Promise<number>;
  /** `merged_into_id` of a business (null when live), or undefined when it does not exist. */
  mergedInto(businessId: string): Promise<string | null | undefined>;
  /** Which of `businessIds` the workspace tracks and no other workspace does. */
  trackedOnlyBy(organizationId: string, businessIds: readonly string[]): Promise<Set<string>>;
  /** Records (or refreshes, while open) a possible duplicate pair; ids are ordered internally. */
  recordPossibleDuplicate(businessA: string, businessB: string, score: MatchScore): Promise<void>;
}
export const RESOLUTION_REPOSITORY = Symbol('ResolutionRepository');

export interface DuplicateRecord {
  readonly id: string;
  readonly businessAId: string;
  readonly businessBId: string;
  readonly score: number;
  readonly reasons: MatchScore;
  readonly status: 'open' | 'merged' | 'dismissed';
  readonly createdAt: Date;
  readonly createdAtText: string;
}

/** Manual merge/split and the duplicates queue (BF-016). */
export interface MergeRepository {
  /** Sources linked to a business (ids and whether each has a normalized view). */
  listSources(businessId: string): Promise<Array<{ readonly id: string; readonly hasNormalized: boolean }>>;
  /** Re-points sources (all, or only `sourceIds`) from one business to another; returns how many moved. */
  moveSources(fromId: string, toId: string, sourceIds?: readonly string[]): Promise<number>;
  /** Moves contacts the survivor lacks, drops the rest; moves media and reviews; clears categories and hours. */
  moveSideData(fromId: string, toId: string): Promise<void>;
  /**
   * Folds workspace links of `fromId` into `toId`: most advanced pipeline status (with its reasons), do-not-contact
   * kept with its reason, tags united, owner kept. Returns the workspaces whose survivor became do-not-contact.
   */
  mergeOrgLinks(
    fromId: string,
    toId: string,
  ): Promise<ReadonlyArray<{ readonly organizationId: string; readonly reason: string | null }>>;
  /** Every workspace tracking `fromId` also tracks `toId` (split). */
  copyOrgLinks(fromId: string, toId: string): Promise<void>;
  /** Pairs with `fromId` now concern `toId`; the pair between them becomes `merged`. */
  repointDuplicates(fromId: string, toId: string): Promise<void>;
  /** Which of `businessIds` another workspace (not `organizationId`) also tracks. */
  trackedByOthers(organizationId: string, businessIds: readonly string[]): Promise<Set<string>>;
  /** Which of `businessIds` the workspace tracks. */
  trackedBy(organizationId: string, businessIds: readonly string[]): Promise<Set<string>>;
  listDuplicates(filter: {
    readonly organizationId: string;
    readonly status: 'open' | 'merged' | 'dismissed';
    readonly businessId?: string;
    readonly limit: number;
    readonly before?: { readonly createdAt: string; readonly id: string };
  }): Promise<DuplicateRecord[]>;
  getDuplicate(id: string): Promise<DuplicateRecord | undefined>;
  setDuplicateStatus(id: string, status: 'merged' | 'dismissed'): Promise<void>;
  /** Names and localities for display. */
  businessLabels(
    ids: readonly string[],
  ): Promise<Map<string, { readonly displayName: string; readonly locality: string | null }>>;
}
export const MERGE_REPOSITORY = Symbol('MergeRepository');
