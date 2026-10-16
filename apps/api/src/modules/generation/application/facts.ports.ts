import type { ExtractSiteFactsInput, ExtractSiteFactsOutput, RejectReason, VerifiedSiteFact } from '@bf/ai';
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

// Owner-site extraction (BF-040): the crawl's pages, the model, and the verified facts kept per distinct input.

export const SITE_PAGES_READER = Symbol('SITE_PAGES_READER');
export const SITE_FACT_EXTRACTOR = Symbol('SITE_FACT_EXTRACTOR');
export const SITE_FACT_EXTRACTIONS = Symbol('SITE_FACT_EXTRACTIONS');
export const SITE_FACT_TELEMETRY = Symbol('SITE_FACT_TELEMETRY');

export interface CrawledPage {
  readonly url: string;
  readonly kind: string;
  readonly lang: string | null;
  /** The page's markdown (untrusted), already read from storage. */
  readonly markdown: string;
}

export interface SitePagesReader {
  /** The latest crawl of the business's own website, with the pages whose markdown was kept. */
  latest(businessId: string): Promise<
    | {
        readonly snapshotId: string;
        readonly fetchedAt: Date;
        readonly businessName: string;
        readonly categoryLabel: string | null;
        readonly pages: readonly CrawledPage[];
      }
    | undefined
  >;
}

export interface SiteFactExtractor {
  extract(
    organizationId: string,
    input: ExtractSiteFactsInput,
  ): Promise<{ readonly output: ExtractSiteFactsOutput; readonly model: string }>;
}

export interface StoredExtraction {
  readonly id: string;
  readonly businessId: string;
  readonly snapshotId: string | null;
  readonly inputHash: string;
  readonly model: string;
  readonly facts: readonly VerifiedSiteFact[];
  readonly stats: ExtractionStats;
  readonly observedAt: Date;
}

export interface ExtractionStats {
  readonly pages: number;
  readonly candidates: number;
  readonly accepted: number;
  readonly rejected: Partial<Record<RejectReason, number>>;
  readonly warnings: number;
}

export interface SiteFactExtractionStore {
  find(businessId: string, inputHash: string): Promise<StoredExtraction | undefined>;
  /** The newest extraction of the business (the registry reads it). */
  latest(businessId: string): Promise<StoredExtraction | undefined>;
  /** Keeps the first of concurrent saves of the same input. */
  save(extraction: Omit<StoredExtraction, 'id'>): Promise<void>;
}

export interface SiteFactTelemetry {
  verified(stats: ExtractionStats): void;
}
