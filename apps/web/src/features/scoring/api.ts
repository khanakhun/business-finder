'use client';

import type { BusinessScoreList, ScoringProfileList, ScoringProfileSummary } from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Scoring data hooks (BF-032). Realtime `scoring.scores.updated` refreshes a business's scores; a finished bulk
// recompute refreshes everything scored (lib/realtime/invalidations.ts).

export function useScoringProfiles() {
  return useQuery({
    queryKey: queryKeys.scoring.profiles(),
    queryFn: async () => (await apiClient().GET('/v1/scoring/profiles')).data as ScoringProfileList,
    staleTime: 60_000,
  });
}

/** The workspace's primary profile (its score and tier fill the listing). */
export function usePrimaryProfile(): ScoringProfileSummary | undefined {
  return useScoringProfiles().data?.items.find((profile) => profile.primary);
}

export function useBusinessScores(businessId: string) {
  return useQuery({
    queryKey: queryKeys.business.scores(businessId),
    queryFn: async () =>
      (await apiClient().GET('/v1/businesses/{id}/scores', { params: { path: { id: businessId } } }))
        .data as BusinessScoreList,
  });
}

export function useRecomputeBusinessScores(businessId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (
        await apiClient().POST('/v1/businesses/{id}/scores/recompute', {
          params: { path: { id: businessId } },
        })
      ).data as BusinessScoreList,
    onSuccess: (data) => {
      client.setQueryData(queryKeys.business.scores(businessId), data);
      // The listing and the pipeline board show the primary profile's tier.
      void client.invalidateQueries({ queryKey: queryKeys.search.all });
      void client.invalidateQueries({ queryKey: queryKeys.crm.all });
    },
  });
}
