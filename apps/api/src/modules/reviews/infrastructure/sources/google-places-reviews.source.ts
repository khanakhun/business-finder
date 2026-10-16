import { type Clock, ExternalServiceError, RateLimitedError } from '@bf/contracts';
import { z } from 'zod';
import { WithResilience } from '../../../platform/resilience/resilience.ts';
import type { ReviewFetch, ReviewFetchContext, ReviewSourceAdapter } from '../../application/ports.ts';
import type { SourceReview } from '../../domain/review.ts';

// Google Places reviews (BF-029): Place Details (New) `GET /v1/places/{id}` with the `reviews,rating,userRatingCount`
// field mask — at most 5 reviews, Enterprise + Atmosphere SKU ($25 per 1,000, 1,000 free per month; verified
// 2026-10-16, see the BF-029 notes). Only behind the workspace gate (owner acknowledgement + key). The author's name
// is used to anonymize the text and dropped; avatars, profile links and review resource names are never read.

export const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
export const GOOGLE_REVIEWS_FIELD_MASK = 'reviews,rating,userRatingCount';
const TIMEOUT_MS = 10_000;
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

const LocalizedText = z.object({ text: z.string().max(10_000), languageCode: z.string().max(20).optional() });
const PlaceReviews = z.object({
  rating: z.number().min(0).max(5).optional().catch(undefined),
  userRatingCount: z.number().int().min(0).optional().catch(undefined),
  reviews: z
    .array(
      z
        .object({
          rating: z.number().min(1).max(5).optional().catch(undefined),
          text: LocalizedText.optional().catch(undefined),
          originalText: LocalizedText.optional().catch(undefined),
          authorAttribution: z
            .object({ displayName: z.string().max(200).optional().catch(undefined) })
            .optional()
            .catch(undefined),
        })
        .passthrough(),
    )
    .max(20)
    .default([])
    .catch([]),
});

export interface GooglePlacesReviewsOptions {
  readonly clock: Clock;
  /** The workspace's Places key (vault), or undefined. */
  readonly key: (organizationId: string) => Promise<string | undefined>;
  readonly costUsd: number;
  readonly baseUrl?: string;
}

export class GooglePlacesReviewsSource implements ReviewSourceAdapter {
  readonly source = 'google_places' as const;
  readonly estimatedCostUsd: number;

  constructor(private readonly options: GooglePlacesReviewsOptions) {
    this.estimatedCostUsd = options.costUsd;
  }

  @WithResilience('google-places-reviews')
  async fetch({ organizationId, subject, signal }: ReviewFetchContext): Promise<ReviewFetch> {
    const placeId = subject.googlePlaceId;
    if (!placeId || !PLACE_ID.test(placeId)) return { kind: 'none' };
    const key = await this.options.key(organizationId);
    if (!key) return { kind: 'none' };
    const url = new URL(`${this.options.baseUrl ?? PLACES_BASE_URL}/places/${encodeURIComponent(placeId)}`);
    // Reviews in their original language are preferred below; the language code only shapes `text`.
    url.searchParams.set('languageCode', subject.locale);
    const response = await fetch(url, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': GOOGLE_REVIEWS_FIELD_MASK },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toError(response);
    const parsed = PlaceReviews.safeParse(json);
    if (!parsed.success) {
      throw new ExternalServiceError('google-places', 'unexpected response', {
        details: { reason: 'UNEXPECTED_RESPONSE', retryable: false },
      });
    }
    const reviews: SourceReview[] = parsed.data.reviews.flatMap((review) => {
      const text = review.originalText ?? review.text;
      if (!text?.text.trim()) return [];
      const name = review.authorAttribution?.displayName;
      return [
        {
          text: text.text,
          ...(review.rating !== undefined ? { rating: Math.round(review.rating) } : {}),
          ...(text.languageCode ? { language: text.languageCode } : {}),
          // Places API does not say whether the owner replied.
          ownerResponded: null,
          knownNames: name ? [name] : [],
        },
      ];
    });
    const { rating, userRatingCount } = parsed.data;
    return {
      kind: 'reviews',
      batch: {
        source: 'google_places',
        reviews,
        rating:
          rating !== undefined && userRatingCount !== undefined
            ? { avg: rating, count: userRatingCount }
            : null,
        fetchedAt: this.options.clock.now(),
        costUsd: this.options.costUsd,
      },
    };
  }
}

/** Bounded, sanitized errors (never the provider's free text, never the key). */
function toError(response: Response): Error {
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    return new RateLimitedError(
      'Google Places quota reached.',
      Number.isFinite(seconds) && seconds >= 0 ? Math.min(60, Math.ceil(seconds)) : undefined,
    );
  }
  return new ExternalServiceError('google-places', `answered ${response.status}`, {
    details: {
      reason: `HTTP_${response.status}`,
      // A wrong key or a bad place id will not fix itself.
      retryable: response.status >= 500,
    },
  });
}
