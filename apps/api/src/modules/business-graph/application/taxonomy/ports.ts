import type {
  CategoryAttributes,
  Locale,
  MappingOrigin,
  MappingStatus,
  OfferRelevance,
  TaxonomyProvider,
} from '@bf/contracts';

// Ports of the taxonomy part of the business-graph module (BF-015).

export interface CategoryRecord {
  readonly id: string;
  readonly slug: string;
  readonly parentId: string | null;
  readonly path: string;
  readonly labels: { readonly en: string; readonly fr: string };
  readonly synonyms: { readonly en: readonly string[]; readonly fr: readonly string[] };
  readonly icon: string | null;
  readonly attributes: CategoryAttributes;
  readonly offerRelevance: OfferRelevance;
  readonly sortOrder: number;
}

export interface MappingRecord {
  readonly id: string;
  readonly provider: TaxonomyProvider;
  readonly providerKey: string;
  readonly providerLabel: string | null;
  readonly categoryId: string;
  readonly confidence: number;
  readonly origin: MappingOrigin;
  readonly status: MappingStatus;
  readonly rationale: string | null;
  readonly createdAt: Date;
  readonly reviewedAt: Date | null;
}

export interface ScoredSlug {
  readonly slug: string;
  readonly score: number;
}

export interface EmbeddingTarget {
  readonly id: string;
  readonly slug: string;
  readonly text: string;
  readonly embeddingModel: string | null;
  readonly embeddingTextHash: string | null;
}

export interface TaxonomyRepository {
  /** Active categories (parents before children) and active mappings. */
  loadActive(): Promise<{ readonly categories: CategoryRecord[]; readonly mappings: MappingRecord[] }>;
  /** Active categories by accent-insensitive trigram similarity of `text` to labels and synonyms. */
  trigramSearch(text: string, limit: number): Promise<ScoredSlug[]>;
  /** Active categories embedded with `model`, nearest to `vector` (cosine). */
  vectorSearch(vector: readonly number[], model: string, limit: number): Promise<ScoredSlug[]>;
  /** Whether any active category is embedded with `model` (vector search is skipped otherwise). */
  hasEmbeddings(model: string): Promise<boolean>;
  listEmbeddingTargets(): Promise<EmbeddingTarget[]>;
  saveEmbedding(id: string, vector: readonly number[], model: string, textHash: string): Promise<void>;
  /** Stores an LLM-learned mapping for review; an existing mapping for the key is left alone. */
  insertLearnedMapping(input: {
    readonly provider: TaxonomyProvider;
    readonly providerKey: string;
    readonly providerLabel: string | null;
    readonly categoryId: string;
    readonly confidence: number;
    readonly rationale: string;
  }): Promise<boolean>;
  listMappings(filter: {
    readonly status: MappingStatus;
    readonly provider?: TaxonomyProvider;
    readonly limit: number;
    readonly before?: { readonly createdAt: string; readonly id: string };
  }): Promise<Array<MappingRecord & { readonly createdAtText: string }>>;
  getMapping(id: string): Promise<MappingRecord | undefined>;
  reviewMapping(
    id: string,
    change: {
      readonly status: MappingStatus;
      readonly categoryId: string;
      readonly confidence: number;
      readonly reviewedBy: string | null;
    },
  ): Promise<MappingRecord | undefined>;
  taxonomyVersion(): Promise<number>;
}
export const TAXONOMY_REPOSITORY = Symbol('TaxonomyRepository');

export type { Locale };
