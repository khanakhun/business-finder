import type { RegistryFact, RegistryFactKind } from '@bf/contracts';
import type { Observation } from '../domain/facts/registry.ts';

// Ports of the fact registry (BF-040): what the business graph and the website snapshot say about a business, the
// workspace's own statements (the overlay) and the snapshots generations read.

export const FACT_SOURCES_READER = Symbol('FACT_SOURCES_READER');
export const FACT_OVERLAY_REPOSITORY = Symbol('FACT_OVERLAY_REPOSITORY');
export const FACT_SNAPSHOTS = Symbol('FACT_SNAPSHOTS');

export interface FactSourcesReader {
  /** Whether the workspace tracks the business (the registry is read through the workspace's list). */
  tracked(organizationId: string, businessId: string): Promise<boolean>;
  /** Every observation the global graph holds (golden record, contacts, hours, categories, latest crawl). */
  observations(businessId: string): Promise<Observation[]>;
}

export interface StoredOverlayFact {
  readonly id: string;
  readonly organizationId: string;
  readonly businessId: string;
  readonly kind: RegistryFactKind;
  readonly value: unknown;
  readonly locale: string | null;
  readonly note: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FactOverlayRepository {
  list(organizationId: string, businessId: string): Promise<StoredOverlayFact[]>;
  get(organizationId: string, businessId: string, id: string): Promise<StoredOverlayFact | undefined>;
  insert(fact: Omit<StoredOverlayFact, 'createdAt' | 'updatedAt'>, at: Date): Promise<StoredOverlayFact>;
  update(
    organizationId: string,
    id: string,
    changes: Partial<Pick<StoredOverlayFact, 'value' | 'locale' | 'note'>>,
    at: Date,
  ): Promise<StoredOverlayFact | undefined>;
  /** Soft delete; false when there was nothing (left) to delete. */
  remove(organizationId: string, businessId: string, id: string, at: Date): Promise<boolean>;
}

export interface FactSnapshotStore {
  /** The snapshot's id: an existing one with the same hash is reused. */
  save(input: {
    organizationId: string;
    businessId: string;
    contentHash: string;
    facts: readonly RegistryFact[];
    stats: Record<string, unknown>;
  }): Promise<string>;
  load(organizationId: string, id: string): Promise<RegistryFact[] | undefined>;
}
