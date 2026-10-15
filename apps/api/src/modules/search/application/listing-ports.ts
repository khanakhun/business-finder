import type { BusinessFacets, BusinessListItem } from '@bf/contracts';
import type { ListingPosition, ListingSort, ListingSpec } from '../domain/listing.ts';

export interface ExportExtras {
  readonly category: string | null;
  readonly address: string | null;
  readonly postalCode: string | null;
  readonly email: string | null;
}

export interface ListingRow {
  readonly item: BusinessListItem;
  /** The sort key as a cursor stores it. */
  readonly cursorValue: string | number | null;
}

/** Hybrid listing reads (BF-022). Every method applies the spec's filters and workspace scope. */
export interface BusinessSearchRepository {
  /** A page in `sort` order (not relevance), after `after`. */
  page(
    spec: ListingSpec,
    sort: ListingSort,
    after: ListingPosition | null,
    limit: number,
  ): Promise<ListingRow[]>;
  /** Rows for these ids (any order); ids outside the spec are left out. */
  byIds(spec: ListingSpec, ids: readonly string[]): Promise<BusinessListItem[]>;
  /** Ranked ids for each text ranker (best first, at most `limit`). */
  rankFullText(spec: ListingSpec, q: string, limit: number): Promise<string[]>;
  rankTrigram(spec: ListingSpec, q: string, limit: number): Promise<string[]>;
  rankVector(spec: ListingSpec, vector: readonly number[], limit: number): Promise<string[]>;
  /** How many businesses match (filters only; text is counted by ranking). */
  count(spec: ListingSpec): Promise<number>;
  /** Columns the CSV export adds to list items: category label, address, best email (when asked). */
  exportExtras(
    ids: readonly string[],
    options: { readonly lang: 'en' | 'fr'; readonly email: boolean },
  ): Promise<Map<string, ExportExtras>>;
  /** Facet counts; with `within`, only over those ids (the ranked text results). */
  facets(spec: ListingSpec, within: readonly string[] | null): Promise<BusinessFacets>;
}
export const BUSINESS_SEARCH_REPOSITORY = Symbol('BusinessSearchRepository');

/** Fused rankings for a short while, so the pages of one search (and its facets) see the same order. */
export interface RankingCache {
  get(key: string): Promise<ReadonlyArray<{ readonly id: string; readonly score: number }> | undefined>;
  set(
    key: string,
    value: ReadonlyArray<{ readonly id: string; readonly score: number }>,
    ttlSeconds: number,
  ): Promise<void>;
}
export const RANKING_CACHE = Symbol('RankingCache');
