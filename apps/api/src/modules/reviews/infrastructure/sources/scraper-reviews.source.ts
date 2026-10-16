import { type Clock, ExternalServiceError } from '@bf/contracts';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { csvObjects, readCapped } from '../../../discovery/index.ts';
import { executeWithSignal, isTransient, policyFor } from '../../../platform/resilience/resilience.ts';
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
/** Deletes KEYS[1] only while it still holds ARGV[1] (compare-and-delete). */
const DELETE_IF_VALUE =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
/** Every job created and not yet confirmed deleted (score: creation time). */
const JOBS_TO_DELETE = 'bf:reviews:scraper-jobs';
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

/**
 * The business's row: matched by place id / cid, else by name — only when exactly one row has that name (a namesake
 * nearby must not lend its reviews).
 */
export function businessRow(
  rows: ReadonlyArray<Record<string, string>>,
  subject: { readonly displayName: string; readonly scraperRefs: readonly string[] },
): Record<string, string> | undefined {
  const refs = new Set(subject.scraperRefs);
  const byRef = rows.find(
    (r) => refs.has(r.place_id ?? '') || refs.has(r.cid ?? '') || refs.has(r.data_id ?? ''),
  );
  if (byRef) return byRef;
  const name = normalizeName(subject.displayName);
  const named = rows.filter((r) => normalizeName(r.title ?? '') === name);
  return named.length === 1 ? named[0] : undefined;
}

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

  async fetch({ organizationId, subject, signal }: ReviewFetchContext): Promise<ReviewFetch> {
    if (!subject.location) return { kind: 'none' };
    const key = this.jobKey(organizationId, subject.businessId);
    const job = await this.options.valkey.get(key);
    if (!job) {
      const id = await this.create(subject.displayName, subject.location, subject.locale, signal);
      // Every job is tracked until the scraper confirms its deletion (nightly sweep: `deleteStaleJobs`).
      await this.options.valkey.zadd(JOBS_TO_DELETE, this.options.clock.now().getTime(), id);
      const set = await this.options.valkey.set(
        key,
        id,
        'EX',
        this.options.maxTimeSeconds + JOB_KEY_MARGIN_SECONDS,
        'NX',
      );
      // Another run for the business started a job first: ours is not needed.
      if (set === null) await this.deleteJob(id);
      return { kind: 'pending', retryAfterMs: 60_000 };
    }
    // Finished jobs are deleted from the scraper (it keeps review text and reviewer names on disk) and forgotten here;
    // a transient failure keeps both, so the next attempt reads the same job instead of scraping again.
    let finished = false;
    try {
      const state = await this.call(`/api/v1/jobs/${encodeURIComponent(job)}`, signal, {}, async (r) =>
        JobState.safeParse(await r.json().catch(() => undefined)),
      ).catch((error: unknown) => {
        // The scraper no longer knows the job: start afresh next time.
        if ((error as { details?: { status?: number } }).details?.status === 404) {
          finished = true;
          throw new ExternalServiceError('maps-scraper', 'job gone', { details: { retryable: true } });
        }
        throw error;
      });
      if (!state.success) throw new ExternalServiceError('maps-scraper', 'unexpected job state');
      const status = state.data.Status.toLowerCase();
      if (status !== 'ok' && status !== 'failed') return { kind: 'pending', retryAfterMs: 30_000 };
      if (status === 'failed') {
        finished = true;
        throw new ExternalServiceError('maps-scraper', 'job failed', { details: { retryable: false } });
      }
      let csv: string;
      try {
        csv = await this.call(`/api/v1/jobs/${encodeURIComponent(job)}/download`, signal, {}, (r) =>
          readCapped(r, MAX_CSV_BYTES),
        );
      } catch (error) {
        // A download that may work next time: wait for it (bounded by the step's deferrals) on the same job.
        if (!signal.aborted && isTransient(error)) return { kind: 'pending', retryAfterMs: 30_000 };
        throw error;
      }
      // Downloaded: whatever happens next (even a CSV that does not parse), the job is done.
      finished = true;
      const row = businessRow(csvObjects(csv, MAX_ROWS), subject);
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
    } catch (error) {
      // A response the scraper will never fix (4xx, too large) ends the job too.
      if ((error as { details?: { retryable?: boolean } }).details?.retryable === false) finished = true;
      throw error;
    } finally {
      // Not on the step's signal: a cancelled run still removes what it read. A failed delete leaves the job
      // tracked for the nightly sweep.
      // Only this job's key: another run may already have started a new job for the business.
      if (finished && (await this.deleteJob(job))) {
        await this.options.valkey.eval(DELETE_IF_VALUE, 1, key, job);
      }
    }
  }

  /** Deletes a job from the scraper (gone already counts) and stops tracking it; false when the scraper failed. */
  private async deleteJob(job: string): Promise<boolean> {
    const deleted = await this.call(
      `/api/v1/jobs/${encodeURIComponent(job)}`,
      AbortSignal.timeout(15_000),
      { method: 'DELETE' },
      async () => true,
    ).catch((error: unknown) => (error as { details?: { status?: number } }).details?.status === 404);
    if (deleted) await this.options.valkey.zrem(JOBS_TO_DELETE, job);
    return deleted;
  }

  /**
   * Nightly sweep: jobs older than their time budget (plus an hour) that were never deleted — a run cancelled, a
   * deferral cap reached, a scraper down at the time — are deleted now. Returns how many went.
   */
  async deleteStaleJobs(now: Date): Promise<number> {
    const before = now.getTime() - (this.options.maxTimeSeconds + 3_600) * 1_000;
    let deleted = 0;
    // Batches of 500 until none is left, or a batch the scraper refused entirely (down: try again tomorrow).
    for (let batch = 0; batch < 100; batch++) {
      const stale = await this.options.valkey.zrangebyscore(JOBS_TO_DELETE, 0, before, 'LIMIT', 0, 500);
      let done = 0;
      for (const job of stale) {
        if (await this.deleteJob(job)) done += 1;
        // A job whose delete fails goes to the back of the queue: it cannot hide newer stale ones.
        else await this.options.valkey.zadd(JOBS_TO_DELETE, 'XX', now.getTime(), job);
      }
      deleted += done;
      if (stale.length < 500 || done === 0) break;
    }
    return deleted;
  }

  private async create(
    name: string,
    location: { lat: number; lng: number },
    locale: string,
    signal: AbortSignal,
  ): Promise<string> {
    // Not retried: a POST that timed out may still have created a job (duplicates scrape twice).
    const created = await this.call(
      '/api/v1/jobs',
      signal,
      {
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
      },
      async (r) => JobCreated.safeParse(await r.json().catch(() => undefined)),
      false,
    );
    if (!created.success) throw new ExternalServiceError('maps-scraper', 'unexpected job answer');
    return created.data.id;
  }

  /**
   * One HTTP exchange, body read included, under the `maps-scraper` policy (timeout, retry with backoff, breaker
   * shared by every call) unless `retry` is false; the step's signal and the attempt's both cancel it.
   */
  private call<T>(
    path: string,
    signal: AbortSignal,
    init: RequestInit,
    read: (response: Response) => Promise<T>,
    retry = true,
  ): Promise<T> {
    // `attempt` already combines the caller's signal with the policy attempt's.
    const exchange = async (attempt: AbortSignal): Promise<T> => {
      const response = await fetch(new URL(path, this.options.baseUrl), {
        ...init,
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([attempt, AbortSignal.timeout(60_000)]),
      });
      if (!response.ok) {
        throw new ExternalServiceError('maps-scraper', `answered ${response.status}`, {
          details: { retryable: response.status >= 500, status: response.status },
        });
      }
      return read(response);
    };
    // The caller's signal stays inside the request: a cancellation never counts as an outage.
    return executeWithSignal(policyFor(retry ? 'maps-scraper' : 'maps-scraper-create'), signal, exchange);
  }
}
