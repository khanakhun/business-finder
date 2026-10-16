import type { AiGateway, ExtractPainSignalsInput, ExtractPainSignalsOutput } from '@bf/ai';
import { fixedClock } from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { describe, expect, it, vi } from 'vitest';
import type {
  CachedVerdict,
  ReviewClassificationCache,
  ReviewInsightsRepository,
} from '../application/ports.ts';
import { ReviewMiningService } from '../application/review-mining.service.ts';
import type { PreparedReview } from '../domain/review.ts';
import {
  checkedEvidence,
  FakeReviewClassifier,
  LlmReviewClassifier,
  reviewKey,
} from './review-classifiers.ts';

const memoryCache = (): ReviewClassificationCache & { store: Map<string, CachedVerdict> } => {
  const store = new Map<string, CachedVerdict>();
  return {
    store,
    getMany: async (org, keys) =>
      new Map(
        keys.flatMap((k) =>
          store.has(`${org}:${k}`) ? [[k, store.get(`${org}:${k}`) as CachedVerdict]] : [],
        ),
      ),
    setMany: async (org, entries) => {
      for (const [k, v] of entries) store.set(`${org}:${k}`, v);
    },
  };
};

type Answer = (input: ExtractPainSignalsInput) => ExtractPainSignalsOutput;
const gatewayAnswering = (answer: Answer) => {
  const run = vi.fn(async (_task: unknown, input: ExtractPainSignalsInput) => ({
    output: answer(input),
    provider: 'anthropic' as const,
    model: 'fast-model',
    promptVersion: 1,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    costUsd: 0.001,
    cached: false,
    latencyMs: 1,
  }));
  return { run, gateway: { run } as unknown as AiGateway };
};

const prepared = (text: string, extra: Partial<PreparedReview> = {}): PreparedReview => ({
  text,
  language: 'en',
  ownerResponded: null,
  ...extra,
});
const tagAll: Answer = (input) => ({
  reviews: input.reviews.map((r) => ({
    id: r.id,
    tags: ['booking_friction'],
    sentiment: -0.5,
    mentionsOwnerResponse: false,
    evidence: 'Customers struggle to book a table.',
  })),
  warnings: [],
});
const context = { categoryLabel: 'Restaurant', locale: 'en' as const };

describe('LlmReviewClassifier', () => {
  it('batches 20 reviews per call and caches each verdict per workspace', async () => {
    const { run, gateway } = gatewayAnswering(tagAll);
    const cache = memoryCache();
    const classifier = new LlmReviewClassifier(gateway, cache);
    const reviews = Array.from({ length: 45 }, (_, i) => prepared(`Review number ${i} about booking`));
    const first = await classifier.classify('org-a', reviews, context);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map((call) => (call[1] as ExtractPainSignalsInput).reviews.length)).toEqual([
      20, 20, 5,
    ]);
    expect(first.reviews.every((r) => r?.tags.includes('booking_friction'))).toBe(true);
    expect(first.costUsd).toBeCloseTo(0.003);

    // Same reviews again: served from the cache, no call. Another workspace does not share it.
    await classifier.classify('org-a', reviews, context);
    expect(run).toHaveBeenCalledTimes(3);
    await classifier.classify('org-b', reviews.slice(0, 2), context);
    expect(run).toHaveBeenCalledTimes(4);
    expect(reviewKey(reviews[0] as PreparedReview)).not.toContain('Review number');
  });

  it('drops answers for unknown or missing ids, unknown tags and bad evidence', async () => {
    const { gateway } = gatewayAnswering(() => ({
      reviews: [
        {
          id: 'r1',
          tags: ['booking_friction', 'booking_friction', 'not_a_tag' as never],
          sentiment: -3,
          mentionsOwnerResponse: true,
          // Quotes five words of the review: refused.
          evidence: 'we had to call three times',
        },
        { id: 'r9', tags: ['other'], sentiment: 0, mentionsOwnerResponse: false, evidence: null },
        {
          id: 'r3',
          tags: [],
          sentiment: 0.4,
          mentionsOwnerResponse: false,
          // Evidence without a tag is ignored.
          evidence: 'Nice enough.',
        },
      ],
      warnings: [],
    }));
    const classifier = new LlmReviewClassifier(gateway, memoryCache());
    const result = await classifier.classify(
      'org',
      [
        prepared('To book we had to call three times, painful.', { ownerResponded: true }),
        prepared('Second review'),
        prepared('Third review'),
      ],
      context,
    );
    expect(result.reviews[0]).toEqual({
      tags: ['booking_friction'],
      sentiment: -1,
      mentionsOwnerResponse: true,
      evidence: null,
      language: 'en',
      ownerResponded: true,
    });
    expect(result.reviews[1]).toBeNull();
    expect(result.reviews[2]).toMatchObject({ tags: [], evidence: null });
    expect(result.model).toBe('fast-model');
  });

  it('anonymizes a paraphrase again before keeping it', () => {
    const review = prepared('The terrace was nice but booking was a nightmare.');
    expect(checkedEvidence('Booking is a nightmare, ask Mr. Dupont.', review)).toBeNull();
    expect(checkedEvidence('Booking is painful; email bob@example.com.', review)).toBeNull();
    expect(checkedEvidence('Booking a table is very hard.', review)).toBe('Booking a table is very hard.');
    expect(checkedEvidence(null, review)).toBeNull();
  });
});

describe('ReviewMiningService', () => {
  it('sends the model anonymized text only (names, handles, e-mails, phones, links removed)', async () => {
    const { run, gateway } = gatewayAnswering(tagAll);
    const insights: ReviewInsightsRepository = {
      find: async () => undefined,
      findForUpdate: async () => undefined,
      save: vi.fn(async () => {}),
      delete: async () => {},
      expiring: async () => [],
      withSource: async () => [],
    };
    const service = new ReviewMiningService(
      new LlmReviewClassifier(gateway, memoryCache()),
      insights,
      { record: vi.fn(async () => {}), list: async () => [], purgeExpired: async () => 0 },
      fixedClock(new Date('2026-10-14T12:00:00Z')),
      createLogger({ service: 'test', level: 'fatal' }),
    );
    // The transaction decorator needs a database: run the merge body directly.
    const { setTransactionalDb } = await import('../../platform/db/transactional.ts');
    setTransactionalDb({ transaction: (fn: (tx: unknown) => unknown) => fn({}) } as never);
    await service.analyze(
      'org',
      {
        businessId: 'b',
        displayName: 'Chez Test',
        location: null,
        categoryLabel: null,
        googlePlaceId: null,
        scraperRefs: [],
        rating: null,
        locale: 'fr',
      },
      {
        source: 'manual',
        reviews: [
          {
            text: 'Merci Julie ! Booking impossible, wrote to resa@chez-test.com and @cheztest, call +590 590 12 34 56, see https://chez-test.com/menu — Marie Dupont',
            ownerResponded: null,
            knownNames: ['Marie Dupont'],
          },
          { text: '   ', ownerResponded: null, knownNames: [] },
        ],
        rating: null,
        fetchedAt: new Date('2026-10-14T12:00:00Z'),
        costUsd: 0,
      },
    );
    expect(run).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(run.mock.calls[0]?.[1]);
    for (const leaked of ['Julie', 'resa@', '@cheztest', '590 12', 'https://', 'Marie', 'Dupont']) {
      expect(sent).not.toContain(leaked);
    }
    expect(sent).toContain('[person]');
    // The blank review was dropped before the call.
    expect((run.mock.calls[0]?.[1] as ExtractPainSignalsInput | undefined)?.reviews).toHaveLength(1);
    expect(insights.save).toHaveBeenCalledTimes(1);
  });
});

describe('FakeReviewClassifier', () => {
  it('tags by keywords and never repeats the review', async () => {
    const result = await new FakeReviewClassifier().classify('org', [
      prepared('Could not book, nobody answers the phone', { rating: 1 }),
      prepared('Fine', { rating: 4 }),
    ]);
    expect(result.reviews[0]).toMatchObject({
      tags: ['booking_friction', 'unreachable_by_phone'],
      sentiment: -1,
    });
    expect(result.reviews[0]?.evidence).not.toContain('nobody answers');
    expect(result.reviews[1]).toMatchObject({ tags: [], evidence: null, sentiment: 0.5 });
  });
});
