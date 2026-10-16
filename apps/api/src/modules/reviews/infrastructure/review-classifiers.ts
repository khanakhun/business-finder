import { createHash } from 'node:crypto';
import {
  type AiGateway,
  type ExtractPainSignalsOutput,
  REVIEWS_PER_CALL,
  ReviewsExtractPainSignals,
} from '@bf/ai';
import { evidenceProblem, PAIN_SIGNAL_TAGS, type PainSignalTag, type ReviewSource } from '@bf/contracts';
import type { Redis } from 'ioredis';
import { ClassificationInterruptedError } from '../application/errors.ts';
import type {
  CachedVerdict,
  ClassificationResult,
  ReviewClassificationCache,
  ReviewClassifier,
} from '../application/ports.ts';
import { stripPersonalDetails } from '../domain/personal-details.ts';
import type { PreparedReview } from '../domain/review.ts';

// Review classifiers (BF-029): the `reviews.extract_pain_signals` task through the AI gateway (batched, per-review
// cache, answers validated), and a deterministic fake for tests and E2E (`FAKE_REVIEWS`).

const CACHE_TTL_SECONDS = 30 * 24 * 3600;
const TAGS = new Set<string>(PAIN_SIGNAL_TAGS);

/** Cache key of a review: the prompt, the anonymized text and the rating (never the text itself). */
export const reviewKey = (review: PreparedReview): string =>
  createHash('sha256')
    .update(`${ReviewsExtractPainSignals.prompt}\n${review.rating ?? ''}\n${review.text}`)
    .digest('hex');

/** A model paraphrase we may keep: anonymized again, short, not a quote of the review. */
export function checkedEvidence(evidence: string | null, review: PreparedReview): string | null {
  if (!evidence) return null;
  const clean = stripPersonalDetails(evidence).trim();
  return clean && evidenceProblem(clean, review.text) === null ? clean : null;
}

const clamp = (value: number) => (Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0);

export class LlmReviewClassifier implements ReviewClassifier {
  constructor(
    private readonly gateway: AiGateway,
    private readonly cache: ReviewClassificationCache,
  ) {}

  async classify(
    organizationId: string,
    reviews: readonly PreparedReview[],
    context: {
      readonly source: ReviewSource;
      readonly categoryLabel: string | null;
      readonly locale: 'en' | 'fr';
      readonly signal?: AbortSignal;
    },
  ): Promise<ClassificationResult> {
    // Per source: a source turned off forgets its verdicts without touching the others'.
    const keys = reviews.map((review) => `${context.source}:${reviewKey(review)}`);
    const cached = await this.cache.getMany(organizationId, keys);
    const verdicts = new Map<string, CachedVerdict>();
    for (const [key, verdict] of cached) verdicts.set(key, verdict);
    const missing = reviews.flatMap((review, index) =>
      verdicts.has(keys[index] as string) ? [] : [{ review, key: keys[index] as string }],
    );
    let costUsd = 0;
    let model = '';
    let promptVersion = 0;
    for (let start = 0; start < missing.length; start += REVIEWS_PER_CALL) {
      const chunk = missing.slice(start, start + REVIEWS_PER_CALL);
      const fresh = new Map<string, CachedVerdict>();
      const result = await this.gateway
        .run(
          ReviewsExtractPainSignals,
          {
            locale: context.locale,
            ...(context.categoryLabel ? { businessCategory: context.categoryLabel.slice(0, 100) } : {}),
            reviews: chunk.map(({ review }, index) => ({
              id: `r${index + 1}`,
              text: review.text,
              ...(review.rating !== undefined ? { rating: review.rating } : {}),
              ...(review.language !== 'und' ? { language: review.language } : {}),
            })),
          },
          { orgId: organizationId, ...(context.signal ? { signal: context.signal } : {}) },
        )
        .catch((error: unknown) => {
          // Earlier batches are paid for and cached: the caller books their cost.
          throw costUsd > 0 ? new ClassificationInterruptedError(error, costUsd) : error;
        });
      costUsd += result.costUsd ?? 0;
      model = result.model;
      promptVersion = result.promptVersion;
      const answers = new Map(
        (result.output as ExtractPainSignalsOutput).reviews.map((answer) => [answer.id, answer]),
      );
      chunk.forEach(({ review, key }, index) => {
        const answer = answers.get(`r${index + 1}`);
        // A review the model skipped is left out (never guessed).
        if (!answer) return;
        const verdict: CachedVerdict = {
          tags: [...new Set(answer.tags.filter((tag) => TAGS.has(tag)))] as PainSignalTag[],
          sentiment: clamp(answer.sentiment),
          mentionsOwnerResponse: answer.mentionsOwnerResponse,
          evidence: answer.tags.length > 0 ? checkedEvidence(answer.evidence, review) : null,
          model: result.model,
          promptVersion: result.promptVersion,
        };
        verdicts.set(key, verdict);
        fresh.set(key, verdict);
      });
      // Cached batch by batch: a later failure does not make a retry pay for these again.
      if (fresh.size > 0) await this.cache.setMany(organizationId, fresh, CACHE_TTL_SECONDS);
    }
    const first = verdicts.values().next().value as CachedVerdict | undefined;
    return {
      reviews: reviews.map((review, index) => {
        const verdict = verdicts.get(keys[index] as string);
        return verdict
          ? {
              tags: verdict.tags,
              sentiment: verdict.sentiment,
              mentionsOwnerResponse: verdict.mentionsOwnerResponse,
              evidence: verdict.evidence,
              language: review.language,
              ownerResponded: review.ownerResponded,
            }
          : null;
      }),
      costUsd,
      model: model || first?.model || 'unknown',
      promptVersion: promptVersion || first?.promptVersion || 0,
    };
  }

  forget(organizationId: string, source: ReviewSource): Promise<void> {
    return this.cache.forget(organizationId, source);
  }
}

/** Per-review verdicts in Valkey, per workspace and source (pasted reviews are workspace input). */
export class ValkeyReviewClassificationCache implements ReviewClassificationCache {
  constructor(private readonly valkey: Redis) {}

  private key(organizationId: string, hash: string) {
    return `bf:reviews:verdict:${organizationId}:${hash}`;
  }

  async getMany(organizationId: string, keys: readonly string[]): Promise<Map<string, CachedVerdict>> {
    const found = new Map<string, CachedVerdict>();
    if (keys.length === 0) return found;
    const values = await this.valkey.mget(...keys.map((k) => this.key(organizationId, k)));
    values.forEach((value, index) => {
      if (!value) return;
      try {
        found.set(keys[index] as string, JSON.parse(value) as CachedVerdict);
      } catch {
        // A corrupt entry is a miss.
      }
    });
    return found;
  }

  async setMany(
    organizationId: string,
    entries: ReadonlyMap<string, CachedVerdict>,
    ttlSeconds: number,
  ): Promise<void> {
    if (entries.size === 0) return;
    const pipeline = this.valkey.pipeline();
    for (const [hash, verdict] of entries) {
      pipeline.set(this.key(organizationId, hash), JSON.stringify(verdict), 'EX', ttlSeconds);
    }
    await pipeline.exec();
  }

  async forget(organizationId: string, source: ReviewSource): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.valkey.scan(
        cursor,
        'MATCH',
        this.key(organizationId, `${source}:*`),
        'COUNT',
        500,
      );
      if (keys.length > 0) await this.valkey.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }
}

const RULES: ReadonlyArray<readonly [PainSignalTag, RegExp]> = [
  ['booking_friction', /\b(book|booking|reserv|réserv)/iu],
  ['unreachable_by_phone', /\b(phone|call|téléphone|appel|joindre)/iu],
  ['slow_or_no_reply', /\b(no reply|never replied|email|e-mail|message|réponse|répondu)/iu],
  ['website_broken_or_outdated', /\b(website|site)\b/iu],
  ['no_online_menu_or_prices', /\b(menu|carte|price|prix|tarif)/iu],
  ['long_wait_times', /\b(wait|waited|attente|attendu)/iu],
  ['payment_friction', /\b(card|carte bancaire|cash|espèces|payment|paiement)/iu],
  ['positive_strong_reputation', /\b(amazing|best|incroyable|exceptionnel|recommend|recommande)/iu],
];

/**
 * A deterministic classifier for tests and E2E (`FAKE_REVIEWS`; refused in production): keywords → tags, rating →
 * sentiment, and a generic paraphrase per tag (never the review's words).
 */
export class FakeReviewClassifier implements ReviewClassifier {
  async classify(_organizationId: string, reviews: readonly PreparedReview[]): Promise<ClassificationResult> {
    return {
      reviews: reviews.map((review) => {
        const tags = RULES.filter(([, rule]) => rule.test(review.text)).map(([tag]) => tag);
        const french = review.language === 'fr';
        return {
          tags,
          sentiment: review.rating !== undefined ? (review.rating - 3) / 2 : tags.length > 0 ? -0.4 : 0.2,
          mentionsOwnerResponse: /\b(owner replied|réponse du propriétaire)/iu.test(review.text),
          evidence:
            tags.length > 0
              ? french
                ? `Un client signale un souci : ${tags[0]?.replace(/_/g, ' ')}.`
                : `A customer reports an issue: ${tags[0]?.replace(/_/g, ' ')}.`
              : null,
          language: review.language,
          ownerResponded: review.ownerResponded,
        };
      }),
      costUsd: 0,
      model: 'fake-review-classifier',
      promptVersion: 1,
    };
  }

  async forget(): Promise<void> {}
}
