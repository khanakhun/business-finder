import type { AreaCandidate, SearchIntent } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  fromSavedFilters,
  intentToState,
  locationOf,
  searchParsers,
  serializeSearch,
  toApiQuery,
  toSavedFilters,
} from './url-state.ts';

const CAFE = '0192a1b2-0000-7000-8000-000000000001';
const AREA = '0192a1b2-0000-7000-8000-0000000000aa';

const intent = (overrides: Partial<SearchIntent> = {}): SearchIntent => ({
  mode: 'both',
  categories: { ids: [CAFE], includeDescendants: true },
  keywords: ['rooftop'],
  location: { text: 'Gustavia', resolution: null },
  filters: {
    website: 'none',
    minRating: 4,
    maxRating: null,
    minReviews: null,
    maxReviews: 19,
    hasEmail: true,
    hasPhone: null,
    emailVerified: null,
    languages: [],
    priceLevels: [],
    painSignals: [],
    scoreProfile: null,
    minScore: null,
    tiers: [],
    pipelineStatuses: ['qualified'],
    tags: [],
    addedWithinDays: 7,
  },
  sort: { field: 'rating', direction: 'desc' },
  limit: null,
  needsClarification: null,
  confidence: 0.9,
  warnings: [],
  language: 'fr',
  ...overrides,
});

const candidate = (overrides: Partial<AreaCandidate>): AreaCandidate => ({
  areaId: null,
  kind: 'locality',
  label: 'Gustavia',
  geometry: { type: 'Circle', center: { lat: 17.9, lng: -62.85 }, radiusM: 1500 },
  bbox: { west: -62.86, south: 17.89, east: -62.84, north: 17.91 },
  confidence: 0.9,
  source: 'local',
  ...overrides,
});

describe('search URL state', () => {
  it('turns an intent into a fresh search keeping its prompt', () => {
    const state = intentToState(intent(), 'cafés à Gustavia', candidate({ areaId: AREA }));
    expect(state).toMatchObject({
      prompt: 'cafés à Gustavia',
      category: [CAFE],
      keyword: ['rooftop'],
      area: AREA,
      near: null,
      website: 'none',
      'rating[gte]': 4,
      'reviews[lte]': 19,
      hasEmail: 'true',
      hasPhone: null,
      status: ['qualified'],
      tier: null,
      addedWithinDays: 7,
      sort: '-rating',
      mode: 'both',
      run: null,
      tag: null,
    });
    expect(
      intentToState(intent({ sort: { field: 'relevance', direction: 'desc' } }), 'x', null).sort,
    ).toBeNull();
    expect(intentToState(intent({ sort: { field: 'distance', direction: 'asc' } }), 'x', null).sort).toBe(
      'distance',
    );
  });

  it('locates stored areas, circles and unsaved polygons', () => {
    expect(locationOf(candidate({ areaId: AREA }))).toEqual({ area: AREA, near: null, radiusKm: null });
    expect(locationOf(candidate({}))).toEqual({ area: null, near: '17.9,-62.85', radiusKm: 1.5 });
    const polygon = locationOf(
      candidate({
        geometry: { type: 'MultiPolygon', coordinates: [] },
        bbox: { west: -63, south: 17, east: -62, north: 18 },
      }),
    );
    expect(polygon).toMatchObject({ area: null, near: '17.50000,-62.50000' });
    expect(polygon.radiusKm).toBeGreaterThan(70);
  });

  it('builds API queries with set filters only (arrays repeated, website any dropped)', () => {
    expect(
      toApiQuery(
        {
          q: 'spa',
          status: ['qualified', 'won'],
          tag: [],
          website: 'any',
          hasEmail: 'false',
          'rating[gte]': 4.5,
          area: null,
        },
        '-score',
      ),
    ).toEqual({
      q: 'spa',
      status: ['qualified', 'won'],
      hasEmail: 'false',
      'rating[gte]': '4.5',
      sort: '-score',
    });
    expect(activeFilterCount({ q: 'spa', status: ['new'], website: 'none' })).toBe(2);
  });

  it('round-trips filters through a saved search', () => {
    const state = {
      category: [CAFE],
      'reviews[lte]': 19,
      hasEmail: 'true' as const,
      near: '17.9,-62.85',
      radiusKm: 2,
    };
    const saved = toSavedFilters(state);
    expect(saved).toEqual({
      category: [CAFE],
      'reviews[lte]': '19',
      hasEmail: 'true',
      near: '17.9,-62.85',
      radiusKm: '2',
    });
    expect(fromSavedFilters({ ...saved, colour: 'red' })).toEqual(state);
  });

  it('serializes to a shareable URL and parses it back', () => {
    const url = serializeSearch('/search', {
      prompt: 'cafés',
      category: [CAFE],
      'rating[gte]': 4,
      view: 'map',
      sort: 'name',
    });
    const params = new URL(url, 'https://app.example').searchParams;
    expect(params.get('prompt')).toBe('cafés');
    expect(params.get('rating[gte]')).toBe('4');
    expect(searchParsers.category.parse(params.get('category') as string)).toEqual([CAFE]);
    expect(searchParsers.view.parse(params.get('view') as string)).toBe('map');
    expect(searchParsers.sort.parse('popularity')).toBeNull();
  });
});
