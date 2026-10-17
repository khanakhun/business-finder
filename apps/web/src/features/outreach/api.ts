'use client';

import type {
  CreateDraftRequest,
  EmailDraft,
  EmailLocale,
  EmailTemplate,
  RenderedEmail,
  SaveEmailTemplateRequest,
  UpdateDraftRequest,
} from '@bf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, queryKeys } from '@/lib/api.ts';

// Drafts and templates (BF-051).

const unwrap = <T>({ data, error }: { data?: unknown; error?: unknown }): T => {
  if (error || data === undefined) throw error ?? new Error('No data');
  return data as T;
};

export function useBusinessDrafts(businessId: string | null) {
  return useQuery({
    queryKey: queryKeys.outreach.drafts(businessId ?? ''),
    queryFn: async () =>
      unwrap<{ items: EmailDraft[] }>(
        await apiClient().GET('/v1/outreach/drafts', { params: { query: { businessId: businessId ?? '' } } }),
      ).items,
    enabled: businessId !== null,
  });
}

export function useDraftPreview(draft: EmailDraft | null) {
  return useQuery({
    queryKey: queryKeys.outreach.preview(draft?.id ?? '', draft?.updatedAt ?? ''),
    queryFn: async () =>
      unwrap<RenderedEmail>(
        await apiClient().GET('/v1/outreach/drafts/{id}/preview', {
          params: { path: { id: draft?.id ?? '' } },
        }),
      ),
    enabled: draft !== null,
  });
}

export function useDraftActions() {
  const client = useQueryClient();
  const settle = (draft: EmailDraft) => {
    client.setQueryData(queryKeys.outreach.draft(draft.id), draft);
    void client.invalidateQueries({ queryKey: queryKeys.outreach.drafts(draft.businessId) });
  };
  return {
    create: useMutation({
      mutationFn: async (body: CreateDraftRequest) =>
        unwrap<EmailDraft>(await apiClient().POST('/v1/outreach/drafts', { body: body as never })),
      onSuccess: settle,
    }),
    update: useMutation({
      mutationFn: async ({ id, body }: { id: string; body: UpdateDraftRequest }) =>
        unwrap<EmailDraft>(
          await apiClient().PATCH('/v1/outreach/drafts/{id}', {
            params: { path: { id } },
            body: body as never,
          }),
        ),
      onSuccess: settle,
    }),
    regenerate: useMutation({
      mutationFn: async ({ id, instructions }: { id: string; instructions?: string }) =>
        unwrap<EmailDraft>(
          await apiClient().POST('/v1/outreach/drafts/{id}/regenerate', {
            params: { path: { id } },
            body: (instructions ? { instructions } : {}) as never,
          }),
        ),
      onSuccess: settle,
    }),
    translate: useMutation({
      mutationFn: async ({ id, locale }: { id: string; locale: EmailLocale }) =>
        unwrap<EmailDraft>(
          await apiClient().POST('/v1/outreach/drafts/{id}/translate', {
            params: { path: { id } },
            body: { locale } as never,
          }),
        ),
      onSuccess: settle,
    }),
  };
}

export function useTemplates(archived = false) {
  return useQuery({
    queryKey: queryKeys.outreach.templates(archived),
    queryFn: async () =>
      unwrap<{ items: EmailTemplate[] }>(
        await apiClient().GET('/v1/templates', {
          params: { query: (archived ? { archived: 'true' } : {}) as never },
        }),
      ).items,
  });
}

export function useTemplateVersions(id: string | null) {
  return useQuery({
    queryKey: queryKeys.outreach.templateVersions(id ?? ''),
    queryFn: async () =>
      unwrap<{ items: EmailTemplate[] }>(
        await apiClient().GET('/v1/templates/{id}/versions', { params: { path: { id: id ?? '' } } }),
      ).items,
    enabled: id !== null,
  });
}

export function useTemplateActions() {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: ['outreach', 'templates'] });
  return {
    lint: useMutation({
      mutationFn: async (body: SaveEmailTemplateRequest) =>
        unwrap<{ issues: EmailTemplate['lint']; variables: string[] }>(
          await apiClient().POST('/v1/templates/lint', { body: body as never }),
        ),
    }),
    create: useMutation({
      mutationFn: async (body: SaveEmailTemplateRequest) =>
        unwrap<EmailTemplate>(await apiClient().POST('/v1/templates', { body: body as never })),
      onSuccess: refresh,
    }),
    saveVersion: useMutation({
      mutationFn: async ({ id, body }: { id: string; body: SaveEmailTemplateRequest }) =>
        unwrap<EmailTemplate>(
          await apiClient().POST('/v1/templates/{id}/versions', {
            params: { path: { id } },
            body: body as never,
          }),
        ),
      onSuccess: refresh,
    }),
    archive: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await apiClient().POST('/v1/templates/{id}/archive', { params: { path: { id } } });
        if (error) throw error;
      },
      onSuccess: refresh,
    }),
  };
}
