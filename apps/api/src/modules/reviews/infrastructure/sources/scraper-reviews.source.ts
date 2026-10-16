import { type Clock, ExternalServiceError } from '@bf/contracts';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { csvObjects, readCapped } from '../../../discovery/index.ts';
import { WithResilience } from '../../../platform/resilience/resilience.ts';
import type { ReviewFetch, ReviewFetchContext, ReviewSourceAdapter } from '../../application/ports.ts';
import type { SourceReview } from '../../domain/review.ts';

// Scraper reviews (BF-029): BF-019 never stores scraped reviews, so they are read on demand. A small job looks the
// business up by name around its location (the self-hosted gosom scraper); the step is deferred while it runs, and
// the business's row (matched by place id / cid, else by name) gives the place page's reviews. Only the job id is
// kept (Valkey, short TTL); the CSV, review text and reviewer names live in memory only.

const JobCreated = z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,100}$/) });
const JobState = z.object({ Status: z.string() }).passthrough();
const UserReview = z
  .object({
    Name: z.string().max(200).optional().catch(undefined),
    Rating: z.coerce.number().min(1).max(5).optional().catch(undefined),
    Description: z.string().max(10_000).optional().catch(undefined),
  })
  .passthrough();
const MAX_ROWS = 50;
const MAX_CSV_BYTES = 5_000_000;
/** How long the scraper job id is remembered (its time budget plus margin). */
const JOB_KEY_MARGIN_SECONDS = 900;
const SEARCH_RADIUS_M = 300;

export interface ScraperReviewsOptions {
  readonly clock: Clock;
  readonly baseUrl: string;
  readonly maxTimeSeconds: number;
  readonly valkey: Redis;
}

const normalizeName = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The scraped place's reviews, as the CSV's `user_reviews` JSON column carries them. */
export function scraperReviews(column: string | undefined): SourceReview[] {
  if (!column?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(column);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 50).flatMap((item) => {
    const review = UserReview.safeParse(item);
    const text = review.success ? review.data.Description?.trim() : undefined;
    if (!review.success || !text) return [];
    return [
      {
        text,
        ...(review.data.Rating !== undefined ? { rating: Math.round(review.data.Rating) } : {}),
        ownerResponded: null,
        knownNames: review.data.Name ? [review.data.Name] : [],
      },
    ];
  });
}

export class ScraperReviewsSource implements ReviewSourceAdapter {
  readonly source = 'gmaps_scraper' as const;
  readonly estimatedCostUsd = 0;

  constructor(private readonly options: ScraperReviewsOptions) {}

  private jobKey(organizationId: string, businessId: string) {
    return `bf:reviews:scraper-job:${organizationId}:${businessId}`;
  }

  @WithResilience('maps-scraper')
  async fetch({ organizationId, subject, signal }: ReviewFetchContext): Promise<ReviewFetch> {
    if (!subject.location) return { kind: 'none' };
    const key = this.jobKey(organizationId, subject.businessId);
    const job = await this.options.valkey.get(key);
    if (!job) {
      const id = await this.create(subject.displayName, subject.location, subject.locale, signal);
      await this.options.valkey.set(key, id, 'EX', this.options.maxTimeSeconds + JOB_KEY_MARGIN_SECONDS);
      return { kind: 'pending', retryAfterMs: 60_000 };
    }
    const state = JobState.safeParse(
      await (await this.request(`/api/v1/jobs/${encodeURIComponent(job)}`, signal))
        .json()
        .catch(() => undefined),
    );
    if (!state.success) throw new ExternalServiceError('maps-scraper', 'unexpected job state');
    const status = state.data.Status.toLowerCase();
    if (status !== 'ok' && status !== 'failed') return { kind: 'pending', retryAfterMs: 30_000 };
    await this.options.valkey.del(key);
    if (status === 'failed') {
      throw new ExternalServiceError('maps-scraper', 'job failed', { details: { retryable: false } });
    }
    const rows = csvObjects(
      await readCapped(
        await this.request(`/api/v1/jobs/${encodeURIComponent(job)}/download`, signal),
        MAX_CSV_BYTES,
      ),
      MAX_ROWS,
    );
    const refs = new Set(subject.scraperRefs);
    const name = normalizeName(subject.displayName);
    const row =
      rows.find((r) => refs.has(r.place_id ?? '') || refs.has(r.cid ?? '') || refs.has(r.data_id ?? '')) ??
      rows.find((r) => normalizeName(r.title ?? '') === name);
    if (!row) return { kind: 'none' };
    const avg = Number(row.review_rating);
    const count = Number(row.review_count);
    return {
      kind: 'reviews',
      batch: {
        source: 'gmaps_scraper',
        reviews: scraperReviews(row.user_reviews),
        rating:
          row.review_rating && avg >= 0 && avg <= 5 && Number.isInteger(count) && count >= 0
            ? { avg, count }
            : null,
        fetchedAt: this.options.clock.now(),
        costUsd: 0,
      },
    };
  }

  private async create(
    name: string,
    location: { lat: number; lng: number },
    locale: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.request('/api/v1/jobs', signal, {
      method: 'POST',
      body: JSON.stringify({
        name: 'bf-reviews',
        keywords: [name.slice(0, 120)],
        lang: locale,
        lat: String(location.lat),
        lon: String(location.lng),
        radius: SEARCH_RADIUS_M,
        zoom: 17,
        depth: 1,
        email: false,
        max_time: this.options.maxTimeSeconds,
      }),
    });
    const created = JobCreated.safeParse(await response.json().catch(() => undefined));
    if (!created.success) throw new ExternalServiceError('maps-scraper', 'unexpected job answer');
    return created.data.id;
  }

  private async request(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(new URL(path, this.options.baseUrl), {
      ...init,
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) {
      throw new ExternalServiceError('maps-scraper', `answered ${response.status}`, {
        details: { retryable: response.status >= 500 },
      });
    }
    return response;
  }
}
