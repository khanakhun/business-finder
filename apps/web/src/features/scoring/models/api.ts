'use client';

import type {
  BuildMlDatasetRequest,
  MlDataset,
  MlModel,
  MlReadiness,
  MlTrainingRun,
  ModelImportance,
  ModelMonitoring,
  ModelPromotion,
  PromoteModelRequest,
  ProspectiveComparison,
  SetShadowModelRequest,
  ShadowAssignment,
  ShadowScore,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Outcome-trained scoring (BF-059): readiness, datasets, training runs, models, shadow, promotion, monitoring.

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export function useMlReadiness(offer: string) {
  return useQuery({
    queryKey: queryKeys.scoringMl.readiness(offer),
    queryFn: async () =>
      unwrap<MlReadiness>(
        await apiClient().GET('/v1/scoring/ml/readiness', { params: { query: { offer: offer as never } } }),
      ),
  });
}

export function useMlDatasets() {
  return useQuery({
    queryKey: queryKeys.scoringMl.datasets(),
    queryFn: async () =>
      unwrap<{ items: MlDataset[] }>(await apiClient().GET('/v1/scoring/ml/datasets')).items,
  });
}

export function useMlRuns() {
  return useQuery({
    queryKey: queryKeys.scoringMl.runs(),
    queryFn: async () =>
      unwrap<{ items: MlTrainingRun[] }>(await apiClient().GET('/v1/scoring/ml/training-runs')).items,
    // A queued or running training refreshes until it ends.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((run) => run.status === 'queued' || run.status === 'running')
        ? 5_000
        : false,
  });
}

export function useMlModels() {
  return useQuery({
    queryKey: queryKeys.scoringMl.models(),
    queryFn: async () => unwrap<{ items: MlModel[] }>(await apiClient().GET('/v1/scoring/ml/models')).items,
  });
}

export function useModelImportance(id: string) {
  return useQuery({
    queryKey: queryKeys.scoringMl.importance(id),
    queryFn: async () =>
      unwrap<ModelImportance>(
        await apiClient().GET('/v1/scoring/ml/models/{id}/importance', { params: { path: { id } } }),
      ).items,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useShadowAssignments() {
  return useQuery({
    queryKey: queryKeys.scoringMl.shadow(),
    queryFn: async () =>
      unwrap<{ items: ShadowAssignment[] }>(await apiClient().GET('/v1/scoring/ml/shadow')).items,
  });
}

export function useComparison(profileId: string | null) {
  return useQuery({
    queryKey: queryKeys.scoringMl.comparison(profileId ?? ''),
    queryFn: async () =>
      unwrap<ProspectiveComparison>(
        await apiClient().GET('/v1/scoring/ml/profiles/{profileId}/comparison', {
          params: { path: { profileId: profileId ?? '' } },
        }),
      ),
    enabled: profileId !== null,
  });
}

export function usePromotions() {
  return useQuery({
    queryKey: queryKeys.scoringMl.promotions(),
    queryFn: async () =>
      unwrap<{ items: ModelPromotion[] }>(await apiClient().GET('/v1/scoring/ml/promotions')).items,
  });
}

export function useMonitoring(id: string) {
  return useQuery({
    queryKey: queryKeys.scoringMl.monitoring(id),
    queryFn: async () =>
      unwrap<{ latest: ModelMonitoring | null }>(
        await apiClient().GET('/v1/scoring/ml/models/{id}/monitoring', { params: { path: { id } } }),
      ).latest,
  });
}

export function useBusinessShadowScores(businessId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.scoringMl.businessShadow(businessId),
    queryFn: async () =>
      unwrap<{ items: ShadowScore[] }>(
        await apiClient().GET('/v1/scoring/ml/businesses/{id}/shadow-scores', {
          params: { path: { id: businessId } },
        }),
      ).items,
    enabled,
  });
}

export function useMlActions() {
  const client = useQueryClient();
  const settle = () => void client.invalidateQueries({ queryKey: ['scoring-ml'] });
  return {
    build: useMutation({
      mutationFn: async (body: BuildMlDatasetRequest) =>
        unwrap<MlDataset>(await apiClient().POST('/v1/scoring/ml/datasets', { body: body as never })),
      onSuccess: settle,
    }),
    train: useMutation({
      mutationFn: async (datasetId: string) =>
        unwrap<MlTrainingRun>(
          await apiClient().POST('/v1/scoring/ml/training-runs', { body: { datasetId } as never }),
        ),
      onSuccess: settle,
    }),
    shadow: useMutation({
      mutationFn: async (body: SetShadowModelRequest) =>
        unwrap<{ items: ShadowAssignment[] }>(
          await apiClient().PUT('/v1/scoring/ml/shadow', { body: body as never }),
        ),
      onSuccess: settle,
    }),
    promote: useMutation({
      mutationFn: async (body: PromoteModelRequest) =>
        unwrap<ModelPromotion>(await apiClient().POST('/v1/scoring/ml/promotions', { body: body as never })),
      onSuccess: () => {
        settle();
        void client.invalidateQueries({ queryKey: ['scoring'] });
      },
    }),
    rollback: useMutation({
      mutationFn: async (profileId: string) =>
        unwrap<ModelPromotion>(
          await apiClient().POST('/v1/scoring/ml/rollbacks', { body: { profileId } as never }),
        ),
      onSuccess: () => {
        settle();
        void client.invalidateQueries({ queryKey: ['scoring'] });
      },
    }),
    monitor: useMutation({
      mutationFn: async (id: string) =>
        unwrap<ModelMonitoring>(
          await apiClient().POST('/v1/scoring/ml/models/{id}/monitoring', { params: { path: { id } } }),
        ),
      onSuccess: settle,
    }),
  };
}
