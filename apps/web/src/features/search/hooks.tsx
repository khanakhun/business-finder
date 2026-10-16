'use client';

import type {
  BusinessFacets,
  BusinessSearchPage,
  CategoryNode,
  GeoAreaFeature,
  Locale,
  ParseSearchIntentResponse,
} from '@bf/contracts';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { useQueryStates } from 'nuqs';
import * as React from 'react';
import { toPickerTree, useCategoryTree } from '@/components/settings/taxonomy-settings.tsx';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { searchParsers, toApiQuery } from './url-state.ts';

type UrlStateHook = ReturnType<typeof useSearchStateFromUrl>;
type SearchState = UrlStateHook[0];
type Patch = Partial<{ [K in keyof SearchState]: SearchState[K] | null }>;
type SearchStateHook = readonly [
  SearchState,
  (patch: Patch | ((current: SearchState) => Patch)) => Promise<URLSearchParams>,
];

function useSearchStateFromUrl() {
  return useQueryStates(searchParsers, { history: 'push' });
}

/**
 * Every update is merged into the whole current state. A partial nuqs update leaves the other keys to be re-read
 * from the router, which (Next 16, shallow pushState) can lag and drop them for a moment — so never send one.
 */
function useMergedSearchState(): SearchStateHook {
  const [state, setState] = useSearchStateFromUrl();
  const set = React.useCallback(
    (patch: Patch | ((current: SearchState) => Patch)) =>
      setState((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) })),
    [setState],
  );
  return [state, set] as const;
}

const SearchStateContext = React.createContext<SearchStateHook | null>(null);

/**
 * One reader/writer of the search URL for the whole page: every component shares it, so a partial update from one
 * (a chip, the discovery panel) can never write another component's stale view of the other keys.
 */
export function SearchStateProvider({ children }: { readonly children: React.ReactNode }) {
  const value = useMergedSearchState();
  return <SearchStateContext.Provider value={value}>{children}</SearchStateContext.Provider>;
}

/** The search's URL state. Filter edits push history entries, so back/forward walks through them. */
export function useSearchState(): SearchStateHook {
  const shared = React.useContext(SearchStateContext);
  if (!shared) throw new Error('useSearchState() outside <SearchStateProvider>');
  return shared;
}

/** The listing query of the current URL, deferred so typing into filters never blocks paint. */
export function useListingQuery() {
  const [state] = useSearchState();
  const query = React.useMemo(() => toApiQuery(state, state.sort), [state]);
  return React.useDeferredValue(query);
}

const PAGE_SIZE = 50;

export function useListing(query: Readonly<Record<string, string | string[]>>) {
  return useInfiniteQuery({
    queryKey: queryKeys.search.listing(query),
    queryFn: async ({ pageParam }) =>
      (
        await apiClient().GET('/v1/businesses', {
          params: {
            query: { ...query, limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) } as never,
          },
        })
      ).data as BusinessSearchPage,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: (previous) => previous,
  });
}

export function useFacets(query: Readonly<Record<string, string | string[]>>) {
  const { sort: _sort, ...filters } = query;
  return useQuery({
    queryKey: queryKeys.search.facets(filters),
    queryFn: async () =>
      (await apiClient().GET('/v1/businesses/facets', { params: { query: filters as never } }))
        .data as BusinessFacets,
    placeholderData: (previous) => previous,
  });
}

export function useParseIntent() {
  const locale = useLocale();
  return useMutation({
    mutationFn: async (prompt: string) =>
      (
        await apiClient().POST('/v1/search/intent', {
          body: { prompt, locale: locale === 'fr' ? 'fr' : 'en' },
        })
      ).data as ParseSearchIntentResponse,
  });
}

export interface CategoryLabel {
  readonly label: string;
  readonly parentId: string | null;
}

/** The category tree (shared cache with settings) and an id → label map in the UI language. */
export function useCategories() {
  const locale = useLocale() as Locale;
  const tree = useCategoryTree(locale);
  const labels = React.useMemo(() => {
    const map = new Map<string, CategoryLabel>();
    const walk = (nodes: readonly CategoryNode[], parentId: string | null) => {
      for (const node of nodes) {
        map.set(node.id, { label: node.label, parentId });
        walk(node.children, node.id);
      }
    };
    walk(tree.data?.items ?? [], null);
    return map;
  }, [tree.data]);
  const picker = React.useMemo(() => toPickerTree(tree.data?.items ?? [], locale), [tree.data, locale]);
  return { tree, labels, picker };
}

/** A stored area (label for the location chip, outline for the map). */
export function useArea(id: string | null) {
  const locale = useLocale();
  return useQuery({
    queryKey: ['geo', 'area', id, locale] as const,
    queryFn: async () =>
      (
        await apiClient().GET('/v1/geo/areas/{id}', {
          params: { path: { id: id as string }, query: { locale: locale === 'fr' ? 'fr' : 'en' } },
        })
      ).data as GeoAreaFeature,
    enabled: id !== null,
    staleTime: 10 * 60_000,
  });
}
