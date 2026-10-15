import type { ProviderCapabilities, ProviderCostModel } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { callCost, estimateCost } from './cost.ts';
import { type ProviderCandidate, selectProviders } from './selection-policy.ts';

const model: ProviderCostModel = {
  currency: 'USD',
  skus: [
    { sku: 'pro', label: 'Pro', perThousandUsd: 32, freeMonthlyCalls: 5_000 },
    { sku: 'enterprise', label: 'Enterprise', perThousandUsd: 35, freeMonthlyCalls: 1_000 },
    { sku: 'ids', label: 'IDs only', perThousandUsd: 0, freeMonthlyCalls: 0 },
  ],
  perResultUsd: null,
  notes: '',
};

describe('cost', () => {
  it('charges only calls beyond the free monthly allowance', () => {
    const pro = model.skus[0] as (typeof model.skus)[number];
    expect(callCost(pro, 0, 100, true)).toBe(0);
    expect(callCost(pro, 4_990, 20, true)).toBe(0.32);
    expect(callCost(pro, 6_000, 1_000, true)).toBe(32);
    expect(callCost(pro, 0, 1_000, false)).toBe(32);
    expect(callCost(pro, 0, 0, true)).toBe(0);
  });

  it('estimates by SKU and tier', () => {
    const estimate = estimateCost(
      model,
      [
        { sku: 'enterprise', calls: 600 },
        { sku: 'enterprise', calls: 600 },
        { sku: 'ids', calls: 50 },
        { sku: 'unknown', calls: 3 },
      ],
      new Map([['enterprise', 500]]),
      true,
    );
    expect(estimate.lines).toEqual([
      { sku: 'enterprise', calls: 1_200, costUsd: 24.5 },
      { sku: 'ids', calls: 50, costUsd: 0 },
      { sku: 'unknown', calls: 3, costUsd: 0 },
    ]);
    expect(estimate.totalUsd).toBe(24.5);
  });
});

const caps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  textQuery: true,
  categoryFilter: true,
  circle: true,
  bbox: true,
  polygon: false,
  maxResultsPerQuery: 60,
  pagination: true,
  ...over,
});
const candidate = (
  id: ProviderCandidate['id'],
  over: Partial<ProviderCandidate> = {},
): ProviderCandidate => ({
  id,
  capabilities: caps(),
  available: true,
  enabled: true,
  configured: true,
  estimatedCostUsd: 0,
  ...over,
});
const needs = { keywords: false, categories: true, tile: 'BBox' } as const;

describe('selectProviders', () => {
  it('follows the workspace preference order', () => {
    const result = selectProviders({
      needs,
      preferenceOrder: ['overture', 'google_places'],
      candidates: [candidate('google_places'), candidate('osm'), candidate('overture')],
      budgetRemainingUsd: null,
    });
    expect(result.selected).toEqual(['overture', 'google_places', 'osm']);
  });

  it('explains every exclusion', () => {
    const result = selectProviders({
      needs: { keywords: true, categories: false, tile: 'Circle' },
      preferenceOrder: [],
      candidates: [
        candidate('gmaps_scraper', { available: false }),
        candidate('foursquare', { enabled: false }),
        candidate('google_places', { configured: false }),
        candidate('overture', { capabilities: caps({ textQuery: false }) }),
        candidate('osm'),
      ],
      budgetRemainingUsd: null,
    });
    expect(result.selected).toEqual(['osm']);
    expect(Object.fromEntries(result.excluded.map((e) => [e.id, e.reason]))).toEqual({
      gmaps_scraper: 'unavailable',
      foursquare: 'disabled',
      google_places: 'not_configured',
      overture: 'unsupported',
    });
  });

  it('admits paid providers while the budget lasts, free ones always', () => {
    const result = selectProviders({
      needs,
      preferenceOrder: ['google_places', 'gmaps_scraper', 'overture'],
      candidates: [
        candidate('google_places', { estimatedCostUsd: 4 }),
        candidate('gmaps_scraper', { estimatedCostUsd: 2 }),
        candidate('overture'),
      ],
      budgetRemainingUsd: 5,
    });
    expect(result.selected).toEqual(['google_places', 'overture']);
    expect(result.excluded).toEqual([{ id: 'gmaps_scraper', reason: 'over_budget' }]);
    const spent = selectProviders({
      needs,
      preferenceOrder: [],
      candidates: [candidate('google_places', { estimatedCostUsd: 0.01 }), candidate('osm')],
      budgetRemainingUsd: 0,
    });
    expect(spent.selected).toEqual(['osm']);
  });

  it('needs bbox or polygon support for box tiles', () => {
    const result = selectProviders({
      needs,
      preferenceOrder: [],
      candidates: [candidate('google_places', { capabilities: caps({ bbox: false, polygon: false }) })],
      budgetRemainingUsd: null,
    });
    expect(result.excluded).toEqual([{ id: 'google_places', reason: 'unsupported' }]);
  });
});

describe('selectProviders edge cases', () => {
  it('serves categories by type filter even when keywords cannot be used, and refuses keyword-only intents', () => {
    const typeOnly = candidate('overture', { capabilities: caps({ textQuery: false }) });
    const both = selectProviders({
      needs: { keywords: true, categories: true, tile: 'BBox' },
      preferenceOrder: [],
      candidates: [typeOnly],
      budgetRemainingUsd: null,
    });
    expect(both.selected).toEqual(['overture']);
    const keywordsOnly = selectProviders({
      needs: { keywords: true, categories: false, tile: 'BBox' },
      preferenceOrder: [],
      candidates: [typeOnly],
      budgetRemainingUsd: null,
    });
    expect(keywordsOnly.excluded).toEqual([{ id: 'overture', reason: 'unsupported' }]);
  });

  it('admits free providers on a spent (zero) budget', () => {
    const result = selectProviders({
      needs,
      preferenceOrder: [],
      candidates: [candidate('osm'), candidate('google_places', { estimatedCostUsd: 0.001 })],
      budgetRemainingUsd: 0,
    });
    expect(result.selected).toEqual(['osm']);
  });
});
