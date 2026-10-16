import { ExternalServiceError, fixedClock, RateLimitedError, type ReviewSourceGate } from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { describe, expect, it, vi } from 'vitest';
import { StepDeferredError, type StepExecution, StepInterruptedError } from '../../../enrichment/index.ts';
import { SpentBeforeFailureError } from '../../application/errors.ts';
import type { ReviewFetch, ReviewSourceAdapter, ReviewSubject } from '../../application/ports.ts';
import type { ReviewBatch } from '../../domain/review.ts';
import { MAX_DEFERRALS, ReviewsStep } from './reviews.step.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
const subject: ReviewSubject = {
  businessId: 'b1',
  displayName: 'Le Test',
  location: { lat: 17.9, lng: -62.85 },
  categoryLabel: 'Restaurant',
  googlePlaceId: 'ChIJtestPlaceId0001',
  scraperRefs: [],
  rating: { avg: 4, count: 10 },
  locale: 'fr',
};
const batch = (source: ReviewBatch['source'], costUsd = 0): ReviewBatch => ({
  source,
  reviews: [{ text: 'Impossible de réserver', ownerResponded: null, knownNames: [] }],
  rating: null,
  fetchedAt: NOW,
  costUsd,
});
const gate = (source: ReviewSourceGate['source']): ReviewSourceGate => ({
  source,
  maxUsage: 'transient_insights',
  usage: 'transient_insights',
  effective: 'transient_insights',
  blockedBy: null,
  retentionDays: 30,
});
const adapter = (
  source: ReviewSourceAdapter['source'],
  fetch: () => Promise<ReviewFetch>,
  estimatedCostUsd = 0,
): ReviewSourceAdapter & { fetch: ReturnType<typeof vi.fn> } => ({
  source,
  estimatedCostUsd,
  fetch: vi.fn(fetch),
});

function setup(
  options: {
    gates?: ReviewSourceGate[];
    adapters?: ReviewSourceAdapter[];
    canSpend?: boolean;
    analyzed?: number;
  } = {},
) {
  const mining = {
    analyze: vi.fn(async (..._args: unknown[]) => ({
      analysed: options.analyzed ?? 1,
      costUsd: 0.002,
      insights: null,
    })),
    observeGoldenRating: vi.fn(async () => {}),
  };
  const step = new ReviewsStep({
    gates: {
      allowedSources: async () => options.gates ?? [gate('manual')],
      isAllowed: async () => true,
    },
    subjects: { find: async () => subject, tracks: async () => true },
    mining,
    adapters: options.adapters ?? [],
    canSpend: async () => options.canSpend ?? true,
    clock,
    logger: createLogger({ service: 'test', level: 'fatal' }),
    ttlDays: 30,
    llmCostUsd: 0.002,
  });
  return { step, mining };
}

const execution = (overrides: Partial<StepExecution> = {}): StepExecution => ({
  runId: 'run',
  stepRowId: 'row',
  organizationId: 'org',
  subject: {
    businessId: 'b1',
    displayName: 'Le Test',
    websiteUrl: null,
    countryCode: 'BL',
    locales: ['fr'],
    emails: [],
  },
  inputHash: 'h',
  dependencies: new Map(),
  signal: new AbortController().signal,
  deferrals: 0,
  ...overrides,
});

describe('ReviewsStep', () => {
  it('skips with licensing_disabled when only pasted reviews are allowed, fetching nothing', async () => {
    const google = adapter('google_places', async () => ({ kind: 'reviews', batch: batch('google_places') }));
    const { step, mining } = setup({ adapters: [google] });
    expect(await step.execute(execution())).toEqual({
      outcome: 'skipped',
      reason: 'licensing_disabled',
      costUsd: 0,
    });
    expect(google.fetch).not.toHaveBeenCalled();
    expect(mining.observeGoldenRating).not.toHaveBeenCalled();
    expect(await step.refreshableFor('org')).toBe(false);
  });

  it('analyses each allowed source and books fetch and model costs', async () => {
    const google = adapter(
      'google_places',
      async () => ({ kind: 'reviews', batch: batch('google_places', 0.025) }),
      0.025,
    );
    const { step, mining } = setup({ gates: [gate('google_places'), gate('manual')], adapters: [google] });
    const result = await step.execute(execution());
    expect(result).toMatchObject({
      outcome: 'done',
      outputRef: { analysed: 1, sources: { google_places: 'analysed' } },
      changedFields: ['review_insights'],
    });
    expect(result.costUsd).toBeCloseTo(0.027);
    expect(mining.observeGoldenRating).toHaveBeenCalledWith(subject);
    expect(await step.refreshableFor('org')).toBe(true);
    expect(step.estimateCost()).toBeCloseTo(0.027);
  });

  it('defers while a scraper job runs, before any paid call, then gives up on it after the bound', async () => {
    const scraper = adapter('gmaps_scraper', async () => ({ kind: 'pending', retryAfterMs: 30_000 }));
    const google = adapter(
      'google_places',
      async () => ({ kind: 'reviews', batch: batch('google_places', 0.025) }),
      0.025,
    );
    const { step } = setup({
      gates: [gate('gmaps_scraper'), gate('google_places')],
      adapters: [scraper, google],
    });
    const deferred = await step.execute(execution()).catch((e: unknown) => e);
    expect(deferred).toBeInstanceOf(StepDeferredError);
    expect((deferred as StepDeferredError).costUsd).toBe(0);
    expect(google.fetch).not.toHaveBeenCalled();

    const finished = await step.execute(execution({ deferrals: MAX_DEFERRALS }));
    expect(finished).toMatchObject({
      outcome: 'done',
      outputRef: {
        sources: { gmaps_scraper: 'timed_out', google_places: 'analysed' },
        recheckAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      },
    });
  });

  it('keeps going when one source fails, and asks for a re-check', async () => {
    const scraper = adapter('gmaps_scraper', async () => {
      throw new Error('scraper down');
    });
    const google = adapter('google_places', async () => ({ kind: 'reviews', batch: batch('google_places') }));
    const { step } = setup({
      gates: [gate('gmaps_scraper'), gate('google_places')],
      adapters: [scraper, google],
    });
    expect(await step.execute(execution())).toMatchObject({
      outcome: 'done',
      outputRef: {
        sources: { gmaps_scraper: 'failed', google_places: 'analysed' },
        recheckAt: expect.any(String),
      },
    });
  });

  it('never rethrows after a paid fetch: a model failure is booked and re-checked, not paid again', async () => {
    const google = adapter(
      'google_places',
      async () => ({ kind: 'reviews', batch: batch('google_places', 0.025) }),
      0.025,
    );
    const { step, mining } = setup({ gates: [gate('google_places')], adapters: [google] });
    mining.analyze.mockRejectedValueOnce(new SpentBeforeFailureError(new Error('model down'), 0.001));
    const result = await step.execute(execution());
    expect(result).toMatchObject({
      outcome: 'done',
      outputRef: { analysed: 0, sources: { google_places: 'failed' }, recheckAt: expect.any(String) },
    });
    // The paid fetch and the model batches paid before the failure.
    expect(result.costUsd).toBeCloseTo(0.026);
  });

  it('re-checks outages and quotas later, and shows configuration errors as the step error', async () => {
    const down = adapter('google_places', async () => {
      throw new Error('socket hang up');
    });
    const { step: outage } = setup({ gates: [gate('google_places')], adapters: [down] });
    expect(await outage.execute(execution())).toMatchObject({
      outcome: 'done',
      costUsd: 0,
      outputRef: { sources: { google_places: 'failed' }, recheckAt: expect.any(String) },
    });

    const quota = adapter('google_places', async () => {
      throw new RateLimitedError('quota', 7);
    });
    const { step: limited } = setup({ gates: [gate('google_places')], adapters: [quota] });
    expect(await limited.execute(execution())).toMatchObject({
      outcome: 'done',
      outputRef: { recheckAt: expect.any(String) },
    });

    const refused = adapter('google_places', async () => {
      throw new ExternalServiceError('google-places', 'answered 403', { details: { retryable: false } });
    });
    const { step: misconfigured } = setup({ gates: [gate('google_places')], adapters: [refused] });
    await expect(misconfigured.execute(execution())).rejects.toThrow('answered 403');
  });

  it('checks the budget with what it already spent, and skips a business that is gone', async () => {
    const google = adapter(
      'google_places',
      async () => ({ kind: 'reviews', batch: batch('google_places', 0.025) }),
      0.025,
    );
    const canSpend = vi.fn(async () => true);
    const { step } = setup({ gates: [gate('google_places')], adapters: [google] });
    (step as unknown as { options: { canSpend: typeof canSpend } }).options.canSpend = canSpend;
    await step.execute(execution());
    expect(canSpend).toHaveBeenCalledWith('org', 0.025);

    const { step: gone } = setup({ gates: [gate('google_places')], adapters: [google] });
    (gone as unknown as { options: { subjects: { find: () => Promise<undefined> } } }).options.subjects = {
      find: async () => undefined,
    };
    expect(await gone.execute(execution())).toEqual({
      outcome: 'skipped',
      reason: 'not_applicable',
      costUsd: 0,
    });
  });

  it('asks the gate again before storing', async () => {
    const google = adapter('google_places', async () => ({ kind: 'reviews', batch: batch('google_places') }));
    const { step, mining } = setup({ gates: [gate('google_places')], adapters: [google] });
    await step.execute(execution());
    const options = mining.analyze.mock.calls[0]?.[3] as { allowed?: () => Promise<boolean> } | undefined;
    expect(await options?.allowed?.()).toBe(true);
  });

  it('skips a paid source the budget cannot pay, and stops at once on cancel', async () => {
    const google = adapter(
      'google_places',
      async () => ({ kind: 'reviews', batch: batch('google_places', 0.025) }),
      0.025,
    );
    const { step } = setup({ gates: [gate('google_places')], adapters: [google], canSpend: false });
    expect(await step.execute(execution())).toMatchObject({
      outcome: 'done',
      costUsd: 0,
      outputRef: { analysed: 0, sources: { google_places: 'budget' } },
      changedFields: [],
    });
    expect(google.fetch).not.toHaveBeenCalled();

    const controller = new AbortController();
    const aborting = adapter('google_places', async () => {
      controller.abort();
      throw new Error('aborted');
    });
    const { step: cancelled } = setup({ gates: [gate('google_places')], adapters: [aborting] });
    await expect(cancelled.execute(execution({ signal: controller.signal }))).rejects.toBeInstanceOf(
      StepInterruptedError,
    );
  });

  it('reports a source without reviews', async () => {
    const google = adapter('google_places', async () => ({ kind: 'none' }));
    const { step } = setup({ gates: [gate('google_places')], adapters: [google] });
    expect(await step.execute(execution())).toMatchObject({
      outcome: 'done',
      outputRef: { analysed: 0, sources: { google_places: 'no_reviews' } },
    });
  });
});
