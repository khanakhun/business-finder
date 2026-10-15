import type { BusinessFilters, BusinessSort, LatLng } from '@bf/contracts';

// Listing specification (BF-022, Specification pattern): the validated filters plus what the application resolved
// (workspace, area, origin for distances, "added since" instant). Infrastructure translates it to SQL.

export type SortKey = 'relevance' | 'score' | 'rating' | 'reviews' | 'distance' | 'recent' | 'name';

export interface ListingSort {
  readonly key: SortKey;
  readonly direction: 'asc' | 'desc';
}

export interface ListingSpec {
  readonly organizationId: string;
  readonly filters: BusinessFilters;
  /** Free text and required keywords; null when the listing has none. */
  readonly text: { readonly q: string | null; readonly keywords: readonly string[] } | null;
  /** Point distances are measured from (`near`, else the area's centre). */
  readonly origin: LatLng | null;
  /** `addedWithinDays` as an instant (from the injected clock). */
  readonly addedSince: Date | null;
}

/** The facet dimensions; each facet query drops its own dimension's filter. */
export type FacetDimension = 'category' | 'status' | 'tier' | 'website' | 'email' | 'rating' | 'locality';

export function hasText(filters: BusinessFilters): boolean {
  return Boolean(filters.q) || (filters.keyword?.length ?? 0) > 0;
}

/** `-score` → score desc. No sort: relevance with text, else most recently tracked first. */
export function parseSort(sort: BusinessSort | undefined, withText: boolean): ListingSort {
  const value = sort ?? (withText ? 'relevance' : '-recent');
  if (value === 'relevance')
    return withText ? { key: 'relevance', direction: 'desc' } : parseSort('-recent', false);
  if (value === 'distance') return { key: 'distance', direction: 'asc' };
  if (value === 'name') return { key: 'name', direction: 'asc' };
  const descending = value.startsWith('-');
  return { key: (descending ? value.slice(1) : value) as SortKey, direction: descending ? 'desc' : 'asc' };
}

/** Where a page ended: the sort it was made with, the last sort value, the last id. */
export interface ListingPosition {
  readonly sort: string;
  readonly value: string | number | null;
  readonly id: string;
}

export const sortName = (sort: ListingSort) => `${sort.direction === 'desc' ? '-' : ''}${sort.key}`;
