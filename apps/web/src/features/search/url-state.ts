import type { AreaCandidate, BusinessSort, SearchIntent } from '@bf/contracts';
import {
  createSerializer,
  type inferParserType,
  parseAsArrayOf,
  parseAsFloat,
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
} from 'nuqs';

// The search lives in the URL (BF-023): shareable, restorable, back/forward-able. Filter parameters use exactly the
// names `GET /v1/businesses` takes (BF-022), so the URL, the API call and a saved search share one shape.

export const SORTS = [
  'relevance',
  '-score',
  'score',
  '-rating',
  'rating',
  '-reviews',
  'reviews',
  'distance',
  '-recent',
  'recent',
  'name',
] as const satisfies readonly BusinessSort[];
export const VIEWS = ['table', 'map'] as const;
export const MODES = ['listings', 'discover', 'both'] as const;
export const WEBSITES = ['any', 'none', 'has', 'weak'] as const;
export const BOOLEANS = ['true', 'false'] as const;
export const STATUSES = [
  'new',
  'qualified',
  'disqualified',
  'contacted',
  'engaged',
  'meeting',
  'proposal',
  'won',
  'lost',
] as const;

const list = parseAsArrayOf(parseAsString);

/** Listing filters (API names). */
export const filterParsers = {
  q: parseAsString,
  keyword: list,
  category: list,
  area: parseAsString,
  near: parseAsString,
  radiusKm: parseAsFloat,
  country: parseAsString,
  website: parseAsStringLiteral(WEBSITES),
  'rating[gte]': parseAsFloat,
  'rating[lte]': parseAsFloat,
  'reviews[gte]': parseAsInteger,
  'reviews[lte]': parseAsInteger,
  'score[gte]': parseAsInteger,
  'score[lte]': parseAsInteger,
  hasEmail: parseAsStringLiteral(BOOLEANS),
  hasPhone: parseAsStringLiteral(BOOLEANS),
  emailVerified: parseAsStringLiteral(BOOLEANS),
  status: list,
  tier: list,
  tag: list,
  owner: parseAsString,
  list: parseAsString,
  /** A discovery run whose results the table follows ("found by this discovery run"). */
  run: parseAsString,
  id: list,
  addedWithinDays: parseAsInteger,
  includeClosed: parseAsStringLiteral(BOOLEANS),
};

/** Everything the page keeps in the URL: the prompt it came from, filters, sort, view, mode, discovery run. */
export const searchParsers = {
  ...filterParsers,
  prompt: parseAsString,
  sort: parseAsStringLiteral(SORTS),
  view: parseAsStringLiteral(VIEWS).withDefault('table'),
  mode: parseAsStringLiteral(MODES).withDefault('both'),
};

export type SearchState = inferParserType<typeof searchParsers>;
export type FilterState = inferParserType<typeof filterParsers>;
export type FilterKey = keyof typeof filterParsers;
export const FILTER_KEYS = Object.keys(filterParsers) as FilterKey[];

export const serializeSearch = createSerializer(searchParsers);

/** Query parameters for the listing/facets/export endpoints: set filters only, arrays as repeated values. */
export function toApiQuery(
  state: Partial<FilterState>,
  sort?: BusinessSort | null,
): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of FILTER_KEYS) {
    const value = state[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) query[key] = [...value];
    } else if (key !== 'website' || value !== 'any') {
      query[key] = String(value);
    }
  }
  if (sort) query.sort = sort;
  return query;
}

/** The filter part of a state, as a saved search stores it (query-string form). */
export function toSavedFilters(state: Partial<FilterState>): Record<string, string | string[]> {
  return toApiQuery(state);
}

/** A saved search's filters back into URL state (unknown keys dropped). */
export function fromSavedFilters(filters: Readonly<Record<string, string | string[]>>): Partial<FilterState> {
  const state: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    const raw = filters[key];
    if (raw === undefined) continue;
    const parser = filterParsers[key] as { parse: (value: string) => unknown };
    const value = parser.parse(Array.isArray(raw) ? raw.join(',') : raw);
    if (value !== null) state[key] = value;
  }
  return state as Partial<FilterState>;
}

export const activeFilterCount = (state: Partial<FilterState>) =>
  Object.keys(toApiQuery({ ...state, q: null })).length;

const EMPTY_FILTERS = Object.fromEntries(FILTER_KEYS.map((k) => [k, null])) as Record<FilterKey, null>;

const sortOf = (sort: SearchIntent['sort']): BusinessSort | null => {
  if (sort.field === 'relevance') return null;
  if (sort.field === 'distance') return 'distance';
  return (sort.direction === 'desc' ? `-${sort.field}` : sort.field) as BusinessSort;
};

/** The location of a resolved candidate: a stored area, else a point and radius. */
export function locationOf(candidate: AreaCandidate): Pick<FilterState, 'area' | 'near' | 'radiusKm'> {
  if (candidate.areaId) return { area: candidate.areaId, near: null, radiusKm: null };
  if (candidate.geometry.type === 'Circle') {
    const { center, radiusM } = candidate.geometry;
    return { area: null, near: `${center.lat},${center.lng}`, radiusKm: Math.max(0.1, radiusM / 1000) };
  }
  // An unsaved polygon: its bounding box's centre and half-diagonal (radius in km, rounded up).
  const { west, south, east, north } = candidate.bbox;
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  const km = Math.hypot((north - south) * 111, (east - west) * 111 * Math.cos((lat * Math.PI) / 180)) / 2;
  return { area: null, near: `${lat.toFixed(5)},${lng.toFixed(5)}`, radiusKm: Math.ceil(Math.max(km, 0.5)) };
}

/**
 * A parsed intent (BF-021) as URL state: a fresh search (every filter reset), keeping the prompt it came from.
 * Pain signals, languages and price levels wait for later tickets' filters.
 */
export function intentToState(
  intent: SearchIntent,
  prompt: string,
  resolvedArea: AreaCandidate | null,
): Partial<SearchState> {
  const f = intent.filters;
  const bool = (value: boolean | null) => (value === null ? null : value ? 'true' : 'false');
  return {
    ...EMPTY_FILTERS,
    prompt,
    keyword: intent.keywords.length > 0 ? intent.keywords : null,
    category: intent.categories.ids.length > 0 ? intent.categories.ids : null,
    ...(resolvedArea ? locationOf(resolvedArea) : {}),
    website: f.website === 'any' ? null : f.website,
    'rating[gte]': f.minRating,
    'rating[lte]': f.maxRating,
    'reviews[gte]': f.minReviews,
    'reviews[lte]': f.maxReviews,
    'score[gte]': f.minScore,
    hasEmail: bool(f.hasEmail),
    hasPhone: bool(f.hasPhone),
    emailVerified: bool(f.emailVerified),
    status: f.pipelineStatuses.length > 0 ? f.pipelineStatuses : null,
    tier: f.tiers.length > 0 ? f.tiers : null,
    tag: f.tags.length > 0 ? f.tags : null,
    addedWithinDays: f.addedWithinDays,
    sort: sortOf(intent.sort),
    mode: intent.mode,
    run: null,
  };
}
