import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ExternalServiceError, fixedClock, RateLimitedError } from '@bf/contracts';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewFetchContext, ReviewSubject } from '../../application/ports.ts';
import { GOOGLE_REVIEWS_FIELD_MASK, GooglePlacesReviewsSource } from './google-places-reviews.source.ts';
import { businessRow, ScraperReviewsSource, scraperReviews } from './scraper-reviews.source.ts';

// Sources against a local HTTP server (port 0): what is asked, what is read, what is never read.

const NOW = new Date('2026-10-14T12:00:00.000Z');
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let handler: Handler;
let server: Server;
let baseUrl: string;
const requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> =
  [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  requests.length = 0;
});

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

const subject: ReviewSubject = {
  businessId: 'b1',
  displayName: 'Restaurant Fictif "La Vague"',
  location: { lat: 17.8971, lng: -62.8497 },
  categoryLabel: 'Restaurant',
  googlePlaceId: 'ChIJFakePlaceId00001',
  scraperRefs: ['ChIJScraperFixture00001'],
  rating: null,
  locale: 'fr',
};
const context = (overrides: Partial<ReviewFetchContext> = {}): ReviewFetchContext => ({
  organizationId: 'org',
  subject,
  signal: new AbortController().signal,
  ...overrides,
});

describe('GooglePlacesReviewsSource', () => {
  const source = (key: string | null = 'AIzaFakeKey') =>
    new GooglePlacesReviewsSource({
      clock: fixedClock(NOW),
      key: async () => key ?? undefined,
      costUsd: 0.025,
      baseUrl,
    });

  it('asks Place Details for reviews only, and keeps text, rating and language — never the author', async () => {
    handler = (_req, res) =>
      json(res, 200, {
        rating: 4.3,
        userRatingCount: 128,
        reviews: [
          {
            name: 'places/ChIJFakePlaceId00001/reviews/abc',
            rating: 2,
            text: { text: 'Booking online is impossible (translated)', languageCode: 'en' },
            originalText: { text: 'Impossible de réserver en ligne', languageCode: 'fr' },
            authorAttribution: {
              displayName: 'Camille Fictive',
              uri: 'https://maps.example/u/1',
              photoUri: 'x',
            },
            publishTime: '2026-09-01T10:00:00Z',
          },
          { rating: 5, text: { text: '  ' } },
          { rating: 4.4, text: { text: 'Great view' } },
        ],
      });
    const fetched = await source().fetch(context());
    expect(requests[0]?.url).toBe('/places/ChIJFakePlaceId00001?languageCode=fr');
    expect(requests[0]?.headers['x-goog-fieldmask']).toBe(GOOGLE_REVIEWS_FIELD_MASK);
    expect(requests[0]?.headers['x-goog-api-key']).toBe('AIzaFakeKey');
    expect(fetched).toEqual({
      kind: 'reviews',
      batch: {
        source: 'google_places',
        reviews: [
          {
            text: 'Impossible de réserver en ligne',
            rating: 2,
            language: 'fr',
            ownerResponded: null,
            knownNames: ['Camille Fictive'],
          },
          { text: 'Great view', rating: 4, ownerResponded: null, knownNames: [] },
        ],
        rating: { avg: 4.3, count: 128 },
        fetchedAt: NOW,
        costUsd: 0.025,
      },
    });
    expect(JSON.stringify(fetched)).not.toContain('maps.example');
  });

  it('does not call without a place id or a key', async () => {
    expect(await source().fetch(context({ subject: { ...subject, googlePlaceId: null } }))).toEqual({
      kind: 'none',
    });
    expect(await source(null).fetch(context())).toEqual({ kind: 'none' });
    expect(requests).toEqual([]);
  });

  it('maps errors without the provider’s text: 4xx is permanent, 429 is a quota', async () => {
    handler = (_req, res) => json(res, 403, { error: { message: 'API key AIzaFakeKey invalid' } });
    const denied = await source()
      .fetch(context())
      .catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ExternalServiceError);
    expect((denied as ExternalServiceError).details?.retryable).toBe(false);
    expect(String((denied as Error).message)).not.toContain('AIza');
    handler = (_req, res) => {
      res.writeHead(429, { 'Retry-After': '7' });
      res.end();
    };
    const limited = await source()
      .fetch(context())
      .catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect((limited as RateLimitedError).retryAfterSeconds).toBe(7);
  });
});

describe('ScraperReviewsSource', () => {
  const store = new Map<string, string>();
  const tracked = new Map<string, number>();
  const valkey = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    eval: async (_script: string, _keys: number, key: string, value: string) =>
      store.get(key) === value && store.delete(key) ? 1 : 0,
    zadd: async (_key: string, score: number, member: string) => {
      tracked.set(member, score);
      return 1;
    },
    zrem: async (_key: string, member: string) => (tracked.delete(member) ? 1 : 0),
    zrangebyscore: async (_key: string, min: number, max: number) =>
      [...tracked].filter(([, score]) => score >= min && score <= max).map(([member]) => member),
  } as unknown as Redis;
  const source = () =>
    new ScraperReviewsSource({ clock: fixedClock(NOW), baseUrl, maxTimeSeconds: 180, valkey });

  const CSV = [
    'title,place_id,cid,review_count,review_rating,user_reviews',
    `"Restaurant Fictif ""La Vague""",ChIJScraperFixture00001,1,42,4.5,"${JSON.stringify([
      {
        Name: 'Reviewer Fictif',
        Rating: 2,
        Description: 'Personne ne répond au téléphone',
        When: '2 weeks ago',
      },
      { Name: 'Autre', Rating: 5, Description: '' },
    ]).replace(/"/g, '""')}"`,
    'Voisin,ChIJOther,2,3,3.9,[]',
  ].join('\n');

  it('starts a job and defers, polls it, then reads the business’s row and forgets the job', async () => {
    let status = 'pending';
    handler = (req, res) => {
      if (req.method === 'DELETE') return json(res, 200, {});
      if (req.method === 'POST') return json(res, 201, { id: 'job-123' });
      if (req.url === '/api/v1/jobs/job-123') return json(res, 200, { Status: status });
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      res.end(CSV);
    };
    expect(await source().fetch(context())).toEqual({ kind: 'pending', retryAfterMs: 60_000 });
    const created = JSON.parse(requests[0]?.body ?? '{}');
    expect(created).toMatchObject({
      keywords: ['Restaurant Fictif "La Vague"'],
      lang: 'fr',
      depth: 1,
      email: false,
    });
    expect(await source().fetch(context())).toEqual({ kind: 'pending', retryAfterMs: 30_000 });
    status = 'ok';
    const fetched = await source().fetch(context());
    expect(fetched).toEqual({
      kind: 'reviews',
      batch: {
        source: 'gmaps_scraper',
        reviews: [
          {
            text: 'Personne ne répond au téléphone',
            rating: 2,
            ownerResponded: null,
            knownNames: ['Reviewer Fictif'],
          },
        ],
        rating: { avg: 4.5, count: 42 },
        fetchedAt: NOW,
        costUsd: 0,
      },
    });
    expect(store.size).toBe(0);
  });

  it('waits on the same job when its download fails, then deletes it; a create is never retried', async () => {
    let failures = 0;
    handler = (req, res) => {
      if (req.method === 'DELETE') return json(res, 200, {});
      if (req.url === '/api/v1/jobs/job-7') return json(res, 200, { Status: 'ok' });
      if (failures < 2) {
        failures += 1;
        return json(res, 503, {});
      }
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      res.end(CSV);
    };
    store.set('bf:reviews:scraper-job:org:b1', 'job-7');
    tracked.set('job-7', NOW.getTime());
    // 503 twice (one retry): the step waits for the same job.
    expect(await source().fetch(context())).toEqual({ kind: 'pending', retryAfterMs: 30_000 });
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(store.get('bf:reviews:scraper-job:org:b1')).toBe('job-7');
    // Next attempt: same job, read, then deleted from the scraper and no longer tracked.
    expect((await source().fetch(context())).kind).toBe('reviews');
    expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual(['/api/v1/jobs/job-7']);
    expect(store.size).toBe(0);
    expect(tracked.has('job-7')).toBe(false);
    expect(requests.filter((r) => r.method === 'POST')).toEqual([]);

    requests.length = 0;
    handler = (_req, res) => json(res, 503, {});
    await expect(source().fetch(context())).rejects.toBeInstanceOf(ExternalServiceError);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('keeps one job per business when two runs start at once, and forgets a job the scraper lost', async () => {
    let next = 0;
    handler = (req, res) => {
      if (req.method === 'DELETE') return json(res, 200, {});
      if (req.method === 'POST') return json(res, 201, { id: `job-n${++next}` });
      return json(res, 404, {});
    };
    store.set('bf:reviews:scraper-job:org:b1', 'job-first');
    // Another run's key won the race after our GET: our new job is deleted at once.
    const raced = source();
    (raced as unknown as { options: { valkey: Redis } }).options.valkey = {
      ...valkey,
      get: async () => null,
    } as unknown as Redis;
    expect((await raced.fetch(context())).kind).toBe('pending');
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/v1/jobs/job-n1')).toBe(true);
    expect(store.get('bf:reviews:scraper-job:org:b1')).toBe('job-first');
    // The scraper no longer knows job-first: forgotten, re-checked later (retryable).
    const gone = await source()
      .fetch(context())
      .catch((e: unknown) => e);
    expect((gone as ExternalServiceError).details?.retryable).toBe(true);
    expect(store.has('bf:reviews:scraper-job:org:b1')).toBe(false);
  });

  it('sweeps stale jobs nightly (gone ones included)', async () => {
    tracked.clear();
    tracked.set('job-old', NOW.getTime() - 3 * 3_600_000);
    tracked.set('job-gone', NOW.getTime() - 3 * 3_600_000);
    tracked.set('job-new', NOW.getTime());
    handler = (req, res) => (req.url === '/api/v1/jobs/job-gone' ? json(res, 404, {}) : json(res, 200, {}));
    expect(await source().deleteStaleJobs(NOW)).toBe(2);
    expect([...tracked.keys()]).toEqual(['job-new']);
  });

  it('fails a failed job, and has nothing for a business without location or row', async () => {
    store.set('bf:reviews:scraper-job:org:b1', 'job-9');
    handler = (_req, res) => json(res, 200, { Status: 'failed' });
    await expect(source().fetch(context())).rejects.toBeInstanceOf(ExternalServiceError);
    // A failed job is deleted from the scraper too.
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/v1/jobs/job-9')).toBe(true);
    expect(store.has('bf:reviews:scraper-job:org:b1')).toBe(false);
    expect(await source().fetch(context({ subject: { ...subject, location: null } }))).toEqual({
      kind: 'none',
    });

    store.set('bf:reviews:scraper-job:org:b1', 'job-10');
    handler = (req, res) => {
      if (req.method === 'DELETE') return json(res, 200, {});
      if (req.url === '/api/v1/jobs/job-10') return json(res, 200, { Status: 'ok' });
      res.writeHead(200);
      res.end('title,place_id\nVoisin,ChIJOther\n');
    };
    expect(await source().fetch(context())).toEqual({ kind: 'none' });
  });

  it('matches the business by reference, else by a name only one row has', () => {
    const rows = [
      { title: 'Chez Jo', place_id: 'A' },
      { title: 'Chez Jo', place_id: 'B' },
      { title: 'Le Port', place_id: 'C' },
    ];
    expect(businessRow(rows, { displayName: 'Chez Jo', scraperRefs: ['B'] })?.place_id).toBe('B');
    expect(businessRow(rows, { displayName: 'Chez Jo', scraperRefs: [] })).toBeUndefined();
    expect(businessRow(rows, { displayName: 'le port', scraperRefs: [] })?.place_id).toBe('C');
  });

  it('parses the user_reviews column defensively', () => {
    expect(scraperReviews(undefined)).toEqual([]);
    expect(scraperReviews('not json')).toEqual([]);
    expect(scraperReviews('{"Name":"x"}')).toEqual([]);
    expect(scraperReviews('[{"Description":"ok","Rating":"4"},{"Rating":3}]')).toEqual([
      { text: 'ok', rating: 4, ownerResponded: null, knownNames: [] },
    ]);
  });
});
