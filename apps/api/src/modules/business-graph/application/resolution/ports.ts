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
  /** Records (or refreshes, while open) a possible duplicate pair; ids are ordered internally. */
  recordPossibleDuplicate(businessA: string, businessB: string, score: MatchScore): Promise<void>;
}
export const RESOLUTION_REPOSITORY = Symbol('ResolutionRepository');
