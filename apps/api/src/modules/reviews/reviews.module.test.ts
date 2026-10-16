import type { ApiEnv } from '@bf/config';
import { fixedClock } from '@bf/contracts';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { SecretResolver } from '../workspace/index.ts';
import { reviewSources } from './reviews.module.ts';

const env = (overrides: Partial<ApiEnv>) =>
  ({
    NODE_ENV: 'test',
    FAKE_REVIEWS: false,
    FEATURE_MAPS_SCRAPER: true,
    MAPS_SCRAPER_URL: 'http://scraper.test',
    MAPS_SCRAPER_MAX_TIME_SECONDS: 180,
    ENRICHMENT_REVIEWS_GOOGLE_COST_USD: 0.025,
    ...overrides,
  }) as ApiEnv;
const clock = fixedClock('2026-10-14T12:00:00Z');
const secrets = { resolve: async () => undefined } as unknown as SecretResolver;
const valkey = {} as Redis;

describe('reviewSources', () => {
  it('asks the asynchronous scraper before the paid Google call (a deferral never repeats a paid call)', () => {
    expect(reviewSources(env({}), clock, secrets, valkey).map((s) => s.source)).toEqual([
      'gmaps_scraper',
      'google_places',
    ]);
    expect(reviewSources(env({ FAKE_REVIEWS: true }), clock, secrets, valkey).map((s) => s.source)).toEqual([
      'gmaps_scraper',
      'google_places',
    ]);
    expect(
      reviewSources(env({ FEATURE_MAPS_SCRAPER: false }), clock, secrets, valkey).map((s) => s.source),
    ).toEqual(['google_places']);
  });

  it('refuses the fakes in production', () => {
    expect(() =>
      reviewSources(env({ FAKE_REVIEWS: true, NODE_ENV: 'production' }), clock, secrets, valkey),
    ).toThrow(/refused in production/);
  });
});
