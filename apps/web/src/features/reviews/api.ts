'use client';

import type {
  AnalyzePastedReviewsRequest,
  BusinessReviewInsights,
  ReviewSourcesStatus,
  UpdateReviewSourcesRequest,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Review mining data hooks (BF-029). A finished enrichment run refreshes the business's queries (realtime), so the
// insights after "Analyse reviews" need no polling.

export function useReviewInsights(id: string) {
  return useQuery({
    queryKey: queryKeys.business.reviews(id),
    queryFn: async () =>
      (await apiClient().GET('/v1/businesses/{id}/review-insights', { params: { path: { id } } }))
        .data as BusinessReviewInsights,
  });
}

export function useAnalyzePastedReviews(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: AnalyzePastedReviewsRequest) =>
      // Ratings are omitted, never sent as undefined.
      (
        await apiClient().POST('/v1/businesses/{id}/reviews/analyze', {
          params: { path: { id } },
          body: {
            reviews: body.reviews.map(({ text, rating }) =>
              rating === undefined ? { text } : { text, rating },
            ),
          },
        })
      ).data as BusinessReviewInsights,
    onSuccess: (saved) => client.setQueryData(queryKeys.business.reviews(id), saved),
  });
}

export function useReviewSources() {
  return useQuery({
    queryKey: queryKeys.reviews.sources(),
    queryFn: async () => (await apiClient().GET('/v1/reviews/sources')).data as ReviewSourcesStatus,
  });
}

/** Scraper opt-in, or the Google acknowledgement (`acknowledge` / `revoke`). */
export function useUpdateReviewSources() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      change:
        | { readonly kind: 'scraper'; readonly body: UpdateReviewSourcesRequest }
        | { readonly kind: 'acknowledge'; readonly termsVersion: number }
        | { readonly kind: 'revoke' },
    ) => {
      const api = apiClient();
      const result =
        change.kind === 'scraper'
          ? await api.PUT('/v1/reviews/sources', { body: change.body })
          : change.kind === 'acknowledge'
            ? await api.POST('/v1/reviews/sources/google/acknowledgement', {
                body: { termsVersion: change.termsVersion },
              })
            : await api.DELETE('/v1/reviews/sources/google/acknowledgement');
      return result.data as ReviewSourcesStatus;
    },
    onSuccess: async (saved) => {
      client.setQueryData(queryKeys.reviews.sources(), saved);
      // Turning a source off forgets its insights: every business page re-reads them.
      await client.invalidateQueries({ queryKey: ['business'] });
    },
  });
}

/** Pasted text → reviews: one per paragraph (blank line between reviews), trimmed, at most `max`. */
export function splitPastedReviews(text: string, max: number, maxChars: number): string[] {
  return text
    .split(/\n\s*\n/)
    .map((review) => review.replace(/\s+/g, ' ').trim())
    .filter((review) => review.length > 0)
    .map((review) => review.slice(0, maxChars))
    .slice(0, max);
}
