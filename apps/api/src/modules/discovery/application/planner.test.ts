import type { MultiPolygon, ProviderCapabilities, ProviderQuery } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { childTiles, dedupeKey, initialTiles, profileFor } from './planner.ts';

const capped: ProviderCapabilities = {
  textQuery: true,
  categoryFilter: true,
  circle: true,
  bbox: false,
  polygon: false,
  maxResultsPerQuery: 60,
  pagination: true,
};
const exhaustive: ProviderCapabilities = {
  ...capped,
  circle: false,
  bbox: true,
  maxResultsPerQuery: 100_000,
};

// ~3.3 km × 2.2 km rectangle around Gustavia.
const area: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-62.87, 17.885],
        [-62.84, 17.885],
        [-62.84, 17.905],
        [-62.87, 17.905],
        [-62.87, 17.885],
      ],
    ],
  ],
};

const query = (over: Partial<ProviderQuery> = {}): ProviderQuery => ({
  provider: 'google_places',
  categoryId: '01920000-0000-7000-8000-000000000001',
  providerKeys: ['restaurant', 'cafe'],
  tile: { type: 'Circle', center: { lat: 17.895, lng: -62.85 }, radiusM: 1_500 },
  languageCode: 'fr',
  fieldTier: 'pro',
  mode: 'nearby',
  pageNumber: 0,
  ...over,
});

describe('profileFor', () => {
  it('gives capped providers small splittable circles and exhaustive ones large unsplit boxes', () => {
    expect(profileFor(capped, 'auto')).toEqual({ shape: 'circle', sizeKm: 1.5, maxDepth: 3 });
    expect(profileFor(exhaustive, 'auto')).toEqual({ shape: 'bbox', sizeKm: 10, maxDepth: 0 });
  });

  it('honours a requested strategy only when the provider supports that shape', () => {
    expect(profileFor({ ...capped, bbox: true }, 'bboxes')).toEqual({
      shape: 'bbox',
      sizeKm: 2,
      maxDepth: 3,
    });
    expect(profileFor(capped, 'bboxes').shape).toBe('circle');
    expect(profileFor(exhaustive, 'circles').shape).toBe('bbox');
  });
});

describe('initialTiles', () => {
  it('covers the area with circles or boxes of the profile size', () => {
    const circles = initialTiles(area, profileFor(capped, 'auto'));
    expect(circles.length).toBeGreaterThan(1);
    expect(circles.every((t) => t.type === 'Circle' && t.radiusM === 1_500)).toBe(true);
    const boxes = initialTiles(area, profileFor(exhaustive, 'auto'));
    expect(boxes.length).toBeGreaterThanOrEqual(1);
    expect(boxes.every((t) => t.type === 'BBox')).toBe(true);
  });
});

describe('childTiles', () => {
  it('splits into quadrants and drops children outside the area', () => {
    const inside = childTiles({ type: 'Circle', center: { lat: 17.895, lng: -62.855 }, radiusM: 800 }, area);
    expect(inside).toHaveLength(4);
    // A tile straddling the eastern edge keeps only the children that touch the area.
    const edge = childTiles(
      { type: 'BBox', bbox: { west: -62.845, south: 17.89, east: -62.825, north: 17.9 } },
      area,
    );
    expect(edge).toHaveLength(2);
  });
});

describe('dedupeKey', () => {
  it('is stable across key order and page tokens, distinct across tiles and pages', () => {
    const base = dedupeKey(query());
    expect(dedupeKey(query({ providerKeys: ['cafe', 'restaurant'] }))).toBe(base);
    expect(dedupeKey(query({ pageToken: 'opaque' }))).toBe(base);
    expect(dedupeKey(query({ pageNumber: 1 }))).not.toBe(base);
    expect(
      dedupeKey(query({ tile: { type: 'Circle', center: { lat: 17.9, lng: -62.85 }, radiusM: 1_500 } })),
    ).not.toBe(base);
    expect(dedupeKey(query({ categoryId: null, keywords: 'pizza' }))).not.toBe(base);
  });
});
