import type { BusinessFacets, BusinessListItem } from '@bf/contracts';
import type { ListingPosition, ListingSort, ListingSpec } from '../domain/listing.ts';

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
  /** Facet counts; with `within`, only over those ids (the ranked text results). */
  facets(spec: ListingSpec, within: readonly string[] | null): Promise<BusinessFacets>;
}
export const BUSINESS_SEARCH_REPOSITORY = Symbol('BusinessSearchRepository');
